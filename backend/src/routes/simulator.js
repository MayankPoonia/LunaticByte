// Transaction simulator for staff (acts as the simulated card gateway from the browser).
// It uses exactly the same validation and authorisation service as POST /api/v1/authorisations;
// only the authentication differs (staff JWT instead of the gateway key, which never reaches the browser).
const express = require('express');
const { query } = require('../db');
const { refs } = require('../data/refs');
const { requireUser, requireRole } = require('../middleware/auth');
const { validateTransaction, CHANNELS } = require('../validation');
const { authorise } = require('../services/authorise');
const { listScenarios } = require('../services/scenarios');
const { toIstIso } = require('../engine/time');

const router = express.Router();
router.use('/simulator', requireUser, requireRole('ANALYST', 'MANAGER'));

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
  if (!body.txn_ts || body.txn_ts === 'now') body.txn_ts = toIstIso(Date.now());
  const txn = validateTransaction(body);
  const { response, duplicate } = await authorise(txn, { source: 'SIMULATOR', actor: { id: req.user.user_id, role: req.user.role } });
  res.set('Idempotent-Replay', duplicate ? 'true' : 'false');
  res.status(duplicate ? 200 : 201).json({ ...response, duplicate, request: { ...body } });
});

module.exports = router;
