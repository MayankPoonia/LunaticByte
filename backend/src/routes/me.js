// Cardholder APIs. Every query is scoped to the customer_id inside the caller's token, so changing a
// card or transaction id in the URL cannot expose another cardholder's data (FR-1): it returns 404.
// Cardholders see plain-language reasons only, never rules, scores or alerts.
const express = require('express');
const { query, withTx } = require('../db');
const { requireUser, requireRole } = require('../middleware/auth');
const stepUps = require('../services/stepUps');
const { blockCard } = require('../services/cards');
const { notifyCommitted } = require('../events/outbox');
const { HttpError } = require('../errors');

const router = express.Router();
router.use('/me', requireUser, requireRole('CARDHOLDER'));

const MESSAGES = {
  CARD_NOT_ACTIVE: 'Declined because the card is not active.',
  INTL_NOT_ENABLED: 'Declined because international use is not enabled on this card.',
  DAILY_LIMIT_EXCEEDED: 'Declined because the daily limit was reached.',
  STEP_UP_DENIED: 'Declined because you told us it was not you. The card has been blocked for your safety.',
  STEP_UP_TIMEOUT: 'Declined because the payment was not confirmed in time.',
};

function customerMessage(status, codes) {
  if (status === 'APPROVED') return 'Payment approved.';
  if (status === 'STEP_UP_PENDING') return 'Please confirm this payment.';
  for (const c of ['STEP_UP_DENIED', 'STEP_UP_TIMEOUT', 'CARD_NOT_ACTIVE', 'INTL_NOT_ENABLED', 'DAILY_LIMIT_EXCEEDED']) {
    if (codes.includes(c)) return MESSAGES[c];
  }
  return 'Declined for your security. Our fraud team may contact you.';
}

const CUSTOMER_TXN = `SELECT t.txn_id, t.card_id, c.last4, t.txn_ts, t.amount, t.currency, m.merchant_name, t.channel, t.txn_city, t.txn_country,
  t.status, t.reason_codes FROM transactions t JOIN cards c ON c.card_id = t.card_id LEFT JOIN merchants m ON m.merchant_id = t.merchant_id`;

const presentTxn = ({ reason_codes: codes, ...t }) => ({ ...t, card: `XXXXXXXXXXXX${t.last4}`, message: customerMessage(t.status, codes || []) });

router.get('/me/cards', async (req, res) => {
  const { rows } = await query(
    `SELECT card_id, last4, card_type, card_status, expiry_date, home_city, daily_limit, international_enabled FROM cards
     WHERE customer_id = $1 ORDER BY card_id`, [req.user.customer_id]);
  res.json({ cards: rows.map((c) => ({ ...c, masked: `XXXXXXXXXXXX${c.last4}` })) });
});

router.get('/me/transactions', async (req, res) => {
  const { rows } = await query(`${CUSTOMER_TXN} WHERE c.customer_id = $1 ORDER BY t.txn_ts DESC LIMIT 100`, [req.user.customer_id]);
  res.json({ transactions: rows.map(presentTxn) });
});

router.get('/me/transactions/:id', async (req, res) => {
  const { rows } = await query(`${CUSTOMER_TXN} WHERE c.customer_id = $1 AND t.txn_id = $2`, [req.user.customer_id, req.params.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Transaction not found');
  res.json({ transaction: presentTxn(rows[0]) });
});

router.get('/me/step-ups', async (req, res) => {
  const { rows } = await query(
    `SELECT s.step_up_id, s.txn_id, s.status, s.expires_at, s.attempts, t.amount, t.txn_ts, t.channel, t.txn_city, m.merchant_name, c.last4
     FROM step_ups s JOIN transactions t ON t.txn_id = s.txn_id JOIN cards c ON c.card_id = s.card_id LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     WHERE s.customer_id = $1 ORDER BY s.created_at DESC LIMIT 20`, [req.user.customer_id]);
  res.json({ step_ups: rows.map((r) => ({ ...r, step_up_id: Number(r.step_up_id), card: `XXXXXXXXXXXX${r.last4}` })) });
});

router.post('/me/step-ups/:id/respond', async (req, res) => {
  res.json(await stepUps.respond(req.params.id, req.user, req.body || {}));
});

// Simulated SMS inbox: the OTP "log" for this cardholder (nothing is actually sent).
router.get('/me/notifications', async (req, res) => {
  const { rows } = await query('SELECT notification_id, kind, message, txn_id, created_at FROM notifications WHERE customer_id = $1 ORDER BY notification_id DESC LIMIT 20',
    [req.user.customer_id]);
  res.json({ notifications: rows });
});

router.post('/me/cards/:id/block', async (req, res) => {
  const card = await withTx(async (client) => {
    const own = await client.query('SELECT card_id FROM cards WHERE card_id = $1 AND customer_id = $2', [req.params.id, req.user.customer_id]);
    if (!own.rows.length) throw new HttpError(404, 'NOT_FOUND', 'Card not found');
    return blockCard(client, req.params.id, { id: req.user.user_id, role: req.user.role }, 'Blocked by cardholder');
  });
  notifyCommitted();
  res.json({ card_id: card.card_id, card_status: 'BLOCKED' });
});

module.exports = router;
