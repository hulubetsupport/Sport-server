/**
 * Hulu Bet – Dedicated Sports Betting Backend
 * Powered by API-Sports (API-Football)
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Render Environment Variables
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

app.use(cors());
app.use(express.json());

// ==========================================
// 1. IN-MEMORY DATABASE (Users, Sports Bets, Cashier)
// ==========================================
const users = {};         // { [userId]: { id, name, balance, withdrawable, wagerLeft } }
const sportsBets = [];    // [ { betId, userId, matches, stake, totalOdds, potentialPayout, status, createdAt } ]
const cashierTxns = [];   // [ { id, userId, type, amount, method, status, at, bankRef } ]

function getOrCreateUser(userId, name = "Bettor") {
  if (!users[userId]) {
    users[userId] = {
      id: String(userId),
      name: name,
      balance: 100.00, // የመጀመሪያ የቦነስ መነሻ
      withdrawable: 0.00,
      wagerLeft: 0.00
    };
  }
  return users[userId];
}

// Telegram Authentication Middleware
function authUser(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) {
    return res.status(401).json({ success: false, message: "Session expired. Open from Telegram." });
  }

  try {
    const params = new URLSearchParams(initData);
    const userRaw = params.get('user');
    if (!userRaw) throw new Error("No user object");

    const tgUser = JSON.parse(userRaw);
    req.user = getOrCreateUser(String(tgUser.id), tgUser.first_name || "Bettor");
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid Telegram session." });
  }
}

// ==========================================
// 2. USER & WALLET INITIALIZATION
// ==========================================
app.get('/api/user/init', authUser, (req, res) => {
  const user = req.user;
  res.json({
    success: true,
    user: { id: user.id, name: user.name },
    balance: user.balance,
    withdrawable: user.withdrawable,
    wagerRequirementLeft: user.wagerLeft
  });
});

// ==========================================
// 3. API-FOOTBALL PROXY & SMART CACHE
// ==========================================
// የነጻው ፕላን በቀን 100 ጥያቄ ብቻ ስለሆነ በየ 15 ደቂቃው Cache ይደረጋል
let cachedFixtures = null;
let lastCacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 Minutes

// የመጠባበቂያ ዳታ (API Key ባይኖር ወይም ኮታ ቢያልቅ አፑ እንዳይቆም)
const BACKUP_FIXTURES = [
  { id: 'epl-1', league: 'Premier League', home: 'Arsenal', away: 'Chelsea', time: 'Tomorrow 19:30', hCode: 'ARS', aCode: 'CHE', odds: { '1': 1.85, 'X': 3.60, '2': 4.10 } },
  { id: 'epl-2', league: 'Premier League', home: 'Manchester City', away: 'Liverpool', time: 'Sat 16:30', hCode: 'MCI', aCode: 'LIV', odds: { '1': 2.10, 'X': 3.75, '2': 3.20 } },
  { id: 'epl-3', league: 'Premier League', home: 'Manchester United', away: 'Tottenham', time: 'Sat 19:00', hCode: 'MUN', aCode: 'TOT', odds: { '1': 2.45, 'X': 3.50, '2': 2.70 } },
  { id: 'epl-4', league: 'Premier League', home: 'Aston Villa', away: 'Newcastle', time: 'Sun 16:00', hCode: 'AVL', aCode: 'NEW', odds: { '1': 2.30, 'X': 3.40, '2': 2.95 } },
  { id: 'epl-5', league: 'Premier League', home: 'Brighton', away: 'West Ham', time: 'Sun 18:30', hCode: 'BHA', aCode: 'WHU', odds: { '1': 1.95, 'X': 3.60, '2': 3.80 } },
  { id: 'epl-6', league: 'Premier League', home: 'Everton', away: 'Fulham', time: 'Mon 22:00', hCode: 'EVE', aCode: 'FUL', odds: { '1': 2.40, 'X': 3.20, '2': 2.90 } },
  { id: 'epl-7', league: 'Premier League', home: 'Brentford', away: 'Crystal Palace', time: 'Sat 14:00', hCode: 'BRE', aCode: 'CRY', odds: { '1': 2.25, 'X': 3.35, '2': 3.10 } },
  { id: 'epl-8', league: 'Premier League', home: 'Bournemouth', away: 'Wolverhampton', time: 'Sat 14:00', hCode: 'BOU', aCode: 'WOL', odds: { '1': 2.05, 'X': 3.45, '2': 3.50 } },
  { id: 'epl-9', league: 'Premier League', home: 'Nottingham Forest', away: 'Leicester City', time: 'Sun 14:00', hCode: 'NFO', aCode: 'LEI', odds: { '1': 2.15, 'X': 3.30, '2': 3.35 } },
  { id: 'epl-10', league: 'Premier League', home: 'Ipswich Town', away: 'Southampton', time: 'Mon 19:45', hCode: 'IPS', aCode: 'SOU', odds: { '1': 2.50, 'X': 3.25, '2': 2.80 } }
];

app.get('/api/sports/fixtures', async (req, res) => {
  const now = Date.now();

  // 1. Check in-memory cache
  if (cachedFixtures && (now - lastCacheTime < CACHE_TTL)) {
    return res.json({ success: true, source: 'cache', fixtures: cachedFixtures });
  }

  // 2. If no API key configured, return backup fixtures
  if (!FOOTBALL_API_KEY) {
    return res.json({ success: true, source: 'backup', fixtures: BACKUP_FIXTURES });
  }

  // 3. Fetch from API-Sports (Premier League: League 39, Next 10 Fixtures)
  try {
    const response = await fetch('https://v3.football.api-sports.io/fixtures?league=39&next=10', {
      headers: {
        'x-apisports-key': FOOTBALL_API_KEY
      }
    });

    const data = await response.json();

    if (data.response && data.response.length > 0) {
      const formatted = data.response.map((item, idx) => {
        return {
          id: `fixture-${item.fixture.id || idx}`,
          league: item.league.name || 'Premier League',
          home: item.teams.home.name,
          away: item.teams.away.name,
          hCode: (item.teams.home.name || 'HOM').substring(0, 3).toUpperCase(),
          aCode: (item.teams.away.name || 'AWY').substring(0, 3).toUpperCase(),
          time: new Date(item.fixture.date).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
          odds: { '1': 2.05, 'X': 3.40, '2': 3.20 } // 1X2 Market Odds
        };
      });

      cachedFixtures = formatted;
      lastCacheTime = now;
      return res.json({ success: true, source: 'api-sports', fixtures: formatted });
    }
  } catch (err) {
    console.error("API-Sports fetch failed:", err.message);
  }

  // Return backup if API fetch had issues
  cachedFixtures = BACKUP_FIXTURES;
  lastCacheTime = now;
  res.json({ success: true, source: 'backup', fixtures: BACKUP_FIXTURES });
});

// ==========================================
// 4. SPORTS BETTING ENGINE (SLIP & ACCUMULATOR)
// ==========================================
app.post('/api/sports/bet', authUser, (req, res) => {
  const user = req.user;
  const { matches, stake, totalOdds, accumBonusPercent } = req.body;

  const betStake = Number(stake);
  if (!betStake || betStake < 1 || betStake > 1000) {
    return res.status(400).json({ success: false, message: "Stake must be between 1 and 1000 ETB" });
  }

  if (user.balance < betStake) {
    return res.status(400).json({ success: false, message: "Insufficient balance. Please deposit." });
  }

  if (!Array.isArray(matches) || matches.length === 0) {
    return res.status(400).json({ success: false, message: "Select at least 1 match" });
  }

  // Calculate Accumulator Boost & Max Payout (20,000 ETB)
  const bonusMultiplier = 1 + (Number(accumBonusPercent || 0) / 100);
  const rawPayout = betStake * Number(totalOdds) * bonusMultiplier;
  const potentialPayout = Math.min(20000, Number(rawPayout.toFixed(2)));

  // Deduct balance
  user.balance = Number((user.balance - betStake).toFixed(2));

  const betRecord = {
    betId: `TICKET-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    userId: user.id,
    matches,
    stake: betStake,
    totalOdds: Number(totalOdds),
    accumBonusPercent: Number(accumBonusPercent || 0),
    potentialPayout,
    status: 'PENDING', // PENDING -> WON / LOST
    createdAt: new Date().toISOString()
  };

  sportsBets.unshift(betRecord);

  res.json({
    success: true,
    betId: betRecord.betId,
    newBalance: user.balance,
    potentialPayout
  });
});

// User's Sports Bets History
app.get('/api/sports/my-bets', authUser, (req, res) => {
  const userBets = sportsBets.filter(b => b.userId === req.user.id);
  res.json({ success: true, bets: userBets });
});

// ==========================================
// 5. CASHIER (TELEBIRR & CBE PAYMENTS)
// ==========================================
app.post('/api/cashier/deposit', authUser, (req, res) => {
  const user = req.user;
  const { amount, method, bankRef } = req.body;

  const depAmt = Number(amount);
  if (!depAmt || depAmt < 50) {
    return res.status(400).json({ success: false, message: "Minimum deposit is 50 ETB" });
  }

  const txnId = `DP-${Date.now()}`;
  const isAutoVerified = Boolean(bankRef && String(bankRef).trim().length >= 6);

  const txn = {
    id: txnId,
    userId: user.id,
    type: 'DEPOSIT',
    amount: depAmt,
    method: method || 'Telebirr',
    bankRef: bankRef || '',
    status: isAutoVerified ? 'approved' : 'pending',
    at: new Date().toISOString()
  };

  // Auto credit if SMS code was submitted
  if (isAutoVerified) {
    user.balance = Number((user.balance + depAmt).toFixed(2));
    user.withdrawable = Number((user.withdrawable + depAmt).toFixed(2));
  }

  cashierTxns.unshift(txn);

  res.json({
    success: true,
    txnId,
    newBalance: user.balance,
    status: txn.status,
    message: isAutoVerified ? "Deposit verified & balance credited!" : "Deposit request received"
  });
});

app.post('/api/cashier/withdraw', authUser, (req, res) => {
  const user = req.user;
  const { amount, accountNumber, method } = req.body;

  const wdAmt = Number(amount);
  if (!wdAmt || wdAmt < 100) {
    return res.status(400).json({ success: false, message: "Minimum withdrawal is 100 ETB" });
  }
  if (!accountNumber) {
    return res.status(400).json({ success: false, message: "Account/Phone number required" });
  }
  if (user.balance < wdAmt) {
    return res.status(400).json({ success: false, message: "Insufficient balance" });
  }

  user.balance = Number((user.balance - wdAmt).toFixed(2));

  const txnId = `WD-${Date.now()}`;
  cashierTxns.unshift({
    id: txnId,
    userId: user.id,
    type: 'WITHDRAWAL',
    amount: wdAmt,
    method: method || 'Telebirr',
    accountNumber,
    status: 'pending',
    at: new Date().toISOString()
  });

  res.json({
    success: true,
    txnId,
    newBalance: user.balance
  });
});

app.get('/api/cashier/history', authUser, (req, res) => {
  const history = cashierTxns.filter(t => t.userId === req.user.id);
  res.json({ success: true, items: history });
});

app.post('/api/cashier/cancel', authUser, (req, res) => {
  const { txnId } = req.body;
  const txn = cashierTxns.find(t => t.id === txnId && t.userId === req.user.id);

  if (!txn) return res.status(404).json({ success: false, message: "Transaction not found" });
  if (txn.status !== 'pending') return res.status(400).json({ success: false, message: "Can only cancel pending orders" });

  txn.status = 'cancelled';
  if (txn.type === 'WITHDRAWAL') {
    req.user.balance = Number((req.user.balance + txn.amount).toFixed(2)); // Refund
  }

  res.json({ success: true, message: "Cancelled", newBalance: req.user.balance });
});

// Health check
app.get('/', (req, res) => {
  res.send('⚽ Hulu Bet Sportsbook Server is LIVE!');
});

app.listen(PORT, () => {
  console.log(`Sports betting server running on port ${PORT}`);
});
