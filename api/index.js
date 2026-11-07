// index.js
const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'SANDBOX';
const CASHFREE_BASE_URL = CASHFREE_ENV === 'PROD' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

const authenticateUser = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.uid = decodedToken.uid;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

const authenticateAdmin = (req, res, next) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_API_KEY) return res.status(403).json({ error: 'Forbidden: Invalid admin key' });
  next();
};

const generateReferralCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

app.post('/auth/signup', authenticateUser, async (req, res) => {
  try {
    const { username, email, referralCode } = req.body;
    const uid = req.uid;
    
    await db.runTransaction(async (t) => {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await t.get(userRef);
      
      if (!userDoc.exists) {
        const newUser = {
          username: username || '',
          email: email || '',
          wallet: 0,
          totalXP: 0,
          joinedMatches: [],
          referralCode: generateReferralCode(),
          referredBy: referralCode || null,
          matchesPlayed: 0,
          totalKills: 0,
          dailyStreak: 0,
          isVIP: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        t.set(userRef, newUser);
      }
    });
    
    res.status(200).json({ success: true, message: 'User initialized' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/wallet/createOrder', authenticateUser, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const orderId = `ORDER_${req.uid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const userRef = db.collection('users').doc(req.uid);
    const userSnap = await userRef.get();
    
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
    const user = userSnap.data();

    const orderPayload = {
      order_id: orderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: req.uid,
        customer_email: user.email || 'guest@example.com',
        customer_phone: user.phone || '9999999999'
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL}/payment/status?order_id={order_id}`
      }
    };

    const response = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01'
      },
      body: JSON.stringify(orderPayload)
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Payment gateway error');

    const txRef = db.collection('transactions').doc(orderId);
    await txRef.set({
      userId: req.uid,
      type: 'DEPOSIT',
      amount: Number(amount),
      status: 'PENDING',
      orderId: orderId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ payment_session_id: data.payment_session_id, order_id: orderId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook/cashfree', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    
    if (!signature || !timestamp) return res.status(400).send('Missing signatures');

    const dataString = timestamp + req.rawBody.toString();
    const expectedSignature = crypto.createHmac('sha256', CASHFREE_SECRET_KEY)
                                    .update(dataString)
                                    .digest('base64');
                                    
    if (signature !== expectedSignature) return res.status(401).send('Invalid signature');

    const payload = req.body;
    const { order_id, payment_status } = payload.data.payment;
    const paymentAmount = payload.data.payment.payment_amount;

    await db.runTransaction(async (t) => {
      const txRef = db.collection('transactions').doc(order_id);
      const txDoc = await t.get(txRef);

      if (!txDoc.exists) return;
      const txData = txDoc.data();
      
      if (txData.status !== 'PENDING') return;

      if (payment_status === 'SUCCESS') {
        const userRef = db.collection('users').doc(txData.userId);
        t.update(userRef, { wallet: admin.firestore.FieldValue.increment(paymentAmount) });
        t.update(txRef, { status: 'SUCCESS', verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
      } else if (payment_status === 'FAILED') {
        t.update(txRef, { status: 'FAILED' });
      }
    });

    res.status(200).send('OK');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/match/join', authenticateUser, async (req, res) => {
  try {
    const { matchId, gameUids } = req.body;
    if (!matchId || !Array.isArray(gameUids) || gameUids.length === 0 || gameUids.length > 4) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    await db.runTransaction(async (t) => {
      const matchRef = db.collection('matches').doc(matchId);
      const userRef = db.collection('users').doc(req.uid);
      
      const [matchDoc, userDoc] = await Promise.all([t.get(matchRef), t.get(userRef)]);
      
      if (!matchDoc.exists) throw new Error('Match not found');
      if (!userDoc.exists) throw new Error('User not found');

      const match = matchDoc.data();
      const user = userDoc.data();

      if (match.status !== 'upcoming') throw new Error('Match is not open for joining');
      if (match.joinedCount + gameUids.length > match.maxPlayers) throw new Error('Match is full');
      if (user.wallet < match.entryFee) throw new Error('Insufficient wallet balance');

      const teamsQuery = db.collection('matches').doc(matchId).collection('teams').where('gameUids', 'array-contains-any', gameUids);
      const duplicates = await t.get(teamsQuery);
      if (!duplicates.empty) throw new Error('One or more gameUids have already joined this match');

      const teamRef = db.collection('matches').doc(matchId).collection('teams').doc(req.uid);
      const teamDoc = await t.get(teamRef);
      if (teamDoc.exists) throw new Error('You have already joined this match');

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-match.entryFee),
        joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
      });

      t.update(matchRef, {
        joinedCount: admin.firestore.FieldValue.increment(gameUids.length)
      });

      t.set(teamRef, {
        ownerUid: req.uid,
        ownerUsername: user.username,
        gameUids: gameUids,
        joinedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: req.uid,
        type: 'MATCH_JOIN',
        amount: -match.entryFee,
        matchId: matchId,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.status(200).json({ success: true, message: 'Joined successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/rewards/daily', authenticateUser, async (req, res) => {
  try {
    const REWARD_AMOUNT = 10;
    
    await db.runTransaction(async (t) => {
      const userRef = db.collection('users').doc(req.uid);
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      
      const user = userDoc.data();
      const now = Date.now();
      const lastReward = user.lastRewardTime ? user.lastRewardTime.toMillis() : 0;
      
      if (now - lastReward < 24 * 60 * 60 * 1000) {
        throw new Error('Reward already claimed today');
      }

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: req.uid,
        type: 'DAILY_REWARD',
        amount: REWARD_AMOUNT,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(REWARD_AMOUNT),
        dailyStreak: admin.firestore.FieldValue.increment(1),
        lastRewardTime: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    
    res.status(200).json({ success: true, message: 'Daily reward claimed' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/wallet/withdraw', authenticateUser, async (req, res) => {
  try {
    const { amount, upiId } = req.body;
    if (!amount || amount <= 0 || !upiId) return res.status(400).json({ error: 'Invalid input' });

    await db.runTransaction(async (t) => {
      const userRef = db.collection('users').doc(req.uid);
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');

      const user = userDoc.data();
      if (user.wallet < amount) throw new Error('Insufficient funds');

      const txRef = db.collection('transactions').doc();
      
      t.update(userRef, { wallet: admin.firestore.FieldValue.increment(-amount) });
      
      t.set(txRef, {
        userId: req.uid,
        type: 'WITHDRAWAL',
        amount: amount,
        upiId: upiId,
        status: 'PENDING',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.status(200).json({ success: true, message: 'Withdrawal requested successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/admin/match/distribute', authenticateAdmin, async (req, res) => {
  try {
    const { matchId, gameUid, rank, kills } = req.body;
    if (!matchId || !gameUid || rank === undefined || kills === undefined) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    await db.runTransaction(async (t) => {
      const matchRef = db.collection('matches').doc(matchId);
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error('Match not found');
      const match = matchDoc.data();

      const teamsRef = db.collection('matches').doc(matchId).collection('teams');
      const teamSnapshot = await t.get(teamsRef.where('gameUids', 'array-contains', gameUid).limit(1));
      
      if (teamSnapshot.empty) throw new Error('Player not found in any team for this match');
      const teamDoc = teamSnapshot.docs[0];
      const team = teamDoc.data();

      if (team.prizeDistributed && team.prizeDistributed[gameUid]) {
        throw new Error('Prize already distributed for this player');
      }

      const rankPrize = match.rankPrizes && match.rankPrizes[rank] ? match.rankPrizes[rank] : 0;
      const totalPrize = (kills * (match.perKillRate || 0)) + rankPrize;
      const xpGained = (kills * 50) + (Math.max(100 - rank * 2, 10)); 

      const userRef = db.collection('users').doc(team.ownerUid);
      
      if (totalPrize > 0) {
        const txRef = db.collection('transactions').doc();
        t.set(txRef, {
          userId: team.ownerUid,
          type: 'MATCH_PRIZE',
          amount: totalPrize,
          matchId: matchId,
          gameUid: gameUid,
          status: 'SUCCESS',
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(totalPrize),
        totalXP: admin.firestore.FieldValue.increment(xpGained),
        totalKills: admin.firestore.FieldValue.increment(kills),
        matchesPlayed: admin.firestore.FieldValue.increment(1)
      });

      const updatedPrizeDistributed = team.prizeDistributed || {};
      updatedPrizeDistributed[gameUid] = true;

      t.update(teamDoc.ref, {
        prizeDistributed: updatedPrizeDistributed
      });
    });

    res.status(200).json({ success: true, message: 'Prize distributed successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
           
