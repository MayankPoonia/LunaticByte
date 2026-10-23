// Transaction simulator (the simulated card gateway on its own page, /simulator in the frontend).
// It uses exactly the same validation and authorisation service as POST /api/v1/authorisations; the
// gateway key never reaches the browser. Access: in DEMO_MODE anyone can use it (a signed-in user is
// recorded as the actor); outside demo mode it requires an analyst or manager token.
const express = require('express');
const { query } = require('../db');
const { refs } = require('../data/refs');
const env = require('../env');
const { verifyToken, STAFF } = require('../middleware/auth');
const { validateTransaction, CHANNELS } = require('../validation');
const { authorise } = require('../services/authorise');
const { listScenarios } = require('../services/scenarios');
const { toIstIsoMs } = require('../engine/time');

const router = express.Router();
function simulatorAccess(req, res, next) {
  const header = req.get('authorization') || '';
  let user = null;
  if (header.startsWith('Bearer ')) {
    try {
      user = verifyToken(header.slice(7));
    } catch {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or expired token' });
    }
  }
  if (env.demoMode) {
    req.actor = user ? { id: user.user_id, role: user.role } : { id: 'simulator', role: 'SIMULATOR' };
    return next();
  }
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Bearer token required' });
  if (!STAFF.includes(user.role)) return res.status(403).json({ error: 'FORBIDDEN', message: 'Requires role ANALYST or MANAGER' });
  req.actor = { id: user.user_id, role: user.role };
  return next();
}

router.use('/simulator', simulatorAccess);

async function nextTxnId() {
  const { rows } = await query("SELECT 'T' || nextval('simulated_txn_seq')::text AS id");
  return rows[0].id;
}

router.get('/simulator/options', async (req, res) => {
  const cards = await query(
    `SELECT c.card_id, c.last4, c.card_type, c.card_status, c.home_city, c.home_country, c.daily_limit, c.international_enabled
     FROM cards c ORDER BY (c.card_id BETWEEN 'C1001' AND 'C1010') DESC, c.card_id LIMIT 80`);
  res.json({
    cards: cards.rows.map((c) => ({ ...c, masked: `XXXXXXXXXXXX${c.last4}` })),
    merchants: [...refs.merchants.values()].map((m) => ({ merchant_id: m.merchant_id, merchant_name: m.merchant_name, mcc: m.mcc, city: m.city, country: m.country, merchant_risk: m.merchant_risk }))
      .sort((a, b) => a.merchant_id.localeCompare(b.merchant_id)),
    cities: [...refs.cities.values()].sort((a, b) => a.city.localeCompare(b.city)),
    channels: CHANNELS,
    batch_limit: 50,
  });
});

router.get('/simulator/scenarios', async (req, res) => res.json({ scenarios: await listScenarios() }));

router.get('/simulator/next-id', async (req, res) => res.json({ txn_id: await nextTxnId() }));

// txn_id and txn_ts are optional here: omitted txn_id gets a fresh sequence id, txn_ts "now" uses the current IST time.
router.post('/simulator/transactions', async (req, res) => {
  const body = { ...(req.body || {}) };
  if (!body.txn_id) body.txn_id = await nextTxnId();
  if (!body.txn_ts || body.txn_ts === 'now') body.txn_ts = toIstIsoMs(Date.now());
  const txn = validateTransaction(body);
  const { response, duplicate } = await authorise(txn, { source: 'SIMULATOR', actor: req.actor });
  res.set('Idempotent-Replay', duplicate ? 'true' : 'false');
  res.status(duplicate ? 200 : 201).json({ ...response, duplicate, request: { ...body } });
});

module.exports = router;
