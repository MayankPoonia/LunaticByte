// Simulated step-up verification (FR-5):
//   STEP_UP_PENDING --CONFIRM + correct OTP within expiry--> APPROVED
//   STEP_UP_PENDING --NOT_ME--> BLOCKED (STEP_UP_DENIED), card BLOCKED, HIGH alert
//   STEP_UP_PENDING --no response before expiry--> BLOCKED (STEP_UP_TIMEOUT), alert
const crypto = require('crypto');
const { withTx } = require('../db');
const log = require('../logger');
const { loadConfig } = require('./ruleConfig');
const { audit } = require('./audit');
const { blockCard } = require('./cards');
const { createAlert } = require('./authorise');
const { addEvent, notifyCommitted } = require('../events/outbox');
const { HttpError } = require('../errors');

const LOCK_SQL = `SELECT s.*, t.amount, t.status AS txn_status, t.reason_codes, t.fraud_score, t.model_status, c.last4
  FROM step_ups s JOIN transactions t ON t.txn_id = s.txn_id JOIN cards c ON c.card_id = s.card_id
  WHERE s.step_up_id = $1 FOR UPDATE OF s, t`;

async function emitStepUp(client, row, status) {
  const payload = { txn_id: row.txn_id, step_up_id: Number(row.step_up_id), status, card_last4: row.last4 };
  await addEvent(client, 'step_up_updated', row.txn_id, payload);
  await addEvent(client, 'step_up_updated', row.txn_id, payload, `customer:${row.customer_id}`);
}

// Moves a pending step-up to BLOCKED with STEP_UP_DENIED or STEP_UP_TIMEOUT and raises the alert.
async function blockStepUp(client, row, code, actor, cfg) {
  const stepStatus = code === 'STEP_UP_DENIED' ? 'DENIED' : 'EXPIRED';
  const reasonCodes = [...row.reason_codes, code];
  await client.query('UPDATE step_ups SET status = $2, resolved_at = now() WHERE step_up_id = $1', [row.step_up_id, stepStatus]);
  await client.query("UPDATE transactions SET status = 'BLOCKED', reason_codes = $2, updated_at = now() WHERE txn_id = $1", [row.txn_id, reasonCodes]);
  await audit(client, { entity: 'STEP_UP', entityId: row.step_up_id, actor: actor.id, role: actor.role, action: `STEP_UP_${stepStatus}`, from: 'PENDING', to: stepStatus });
  await audit(client, { entity: 'TRANSACTION', entityId: row.txn_id, actor: actor.id, role: actor.role, action: code,
    from: 'STEP_UP_PENDING', to: 'BLOCKED', comment: reasonCodes.join('|') });
  if (code === 'STEP_UP_DENIED') await blockCard(client, row.card_id, actor, 'Cardholder answered NOT_ME to step-up');
  const fraudScore = row.fraud_score === null ? null : Number(row.fraud_score);
  const alert = await createAlert(client, {
    txn: { txn_id: row.txn_id, amount: row.amount }, card: { card_id: row.card_id, last4: row.last4 },
    reasonCodes, fraudScore, createdAt: new Date(), cfg, actor: { id: 'system', role: 'SYSTEM' },
  });
  await emitStepUp(client, row, stepStatus);
  await addEvent(client, 'transaction_updated', row.txn_id, { txn_id: row.txn_id, status: 'BLOCKED', reason_codes: reasonCodes, alert_id: Number(alert.alert_id) });
  return { status: 'BLOCKED', reason_codes: reasonCodes, alert_id: Number(alert.alert_id), alert_priority: alert.priority };
}

const otpHash = (txnId, otp) => crypto.createHash('sha256').update(`${txnId}:${otp}`).digest('hex');

async function respond(stepUpId, user, { response, otp }) {
  if (!['CONFIRM', 'NOT_ME'].includes(response)) throw new HttpError(422, 'VALIDATION_ERROR', 'response must be CONFIRM or NOT_ME', [{ field: 'response', message: 'must be CONFIRM or NOT_ME' }]);
  if (response === 'CONFIRM' && !/^\d{6}$/.test(String(otp || ''))) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'otp must be 6 digits', [{ field: 'otp', message: 'must be 6 digits' }]);
  }
  const actor = { id: user.user_id, role: user.role };
  // Failed attempts must be committed, so errors found inside the transaction are thrown after commit.
  const outcome = await withTx(async (client) => {
    const { rows } = await client.query(LOCK_SQL, [stepUpId]);
    const row = rows[0];
    if (!row || row.customer_id !== user.customer_id) return { error: new HttpError(404, 'NOT_FOUND', 'Step-up request not found') };
    if (row.status !== 'PENDING') return { error: new HttpError(409, 'STEP_UP_ALREADY_RESOLVED', `Step-up already ${row.status}`) };
    const cfg = await loadConfig(client);
    if (new Date(row.expires_at) <= new Date()) {
      const result = await blockStepUp(client, row, 'STEP_UP_TIMEOUT', { id: 'system', role: 'SYSTEM' }, cfg);
      return { error: new HttpError(409, 'STEP_UP_EXPIRED', 'Step-up expired; the transaction was blocked', result) };
    }
    if (response === 'NOT_ME') return { result: await blockStepUp(client, row, 'STEP_UP_DENIED', actor, cfg) };

    if (row.attempts >= cfg.otp_max_attempts) return { error: new HttpError(409, 'TOO_MANY_ATTEMPTS', 'Too many wrong OTP attempts; the request will expire') };
    if (otpHash(row.txn_id, otp) !== row.otp_hash) {
      await client.query('UPDATE step_ups SET attempts = attempts + 1 WHERE step_up_id = $1', [row.step_up_id]);
      await audit(client, { entity: 'STEP_UP', entityId: row.step_up_id, actor: actor.id, role: actor.role, action: 'OTP_REJECTED', comment: `attempt ${row.attempts + 1}` });
      const remaining = cfg.otp_max_attempts - row.attempts - 1;
      return { error: new HttpError(422, 'INVALID_OTP', `Incorrect OTP. ${remaining} attempt(s) left`, [{ field: 'otp', message: 'incorrect', remaining }]) };
    }
    await client.query("UPDATE step_ups SET status = 'CONFIRMED', resolved_at = now() WHERE step_up_id = $1", [row.step_up_id]);
    await client.query("UPDATE transactions SET status = 'APPROVED', updated_at = now() WHERE txn_id = $1", [row.txn_id]);
    await audit(client, { entity: 'STEP_UP', entityId: row.step_up_id, actor: actor.id, role: actor.role, action: 'STEP_UP_CONFIRMED', from: 'PENDING', to: 'CONFIRMED' });
    await audit(client, { entity: 'TRANSACTION', entityId: row.txn_id, actor: actor.id, role: actor.role, action: 'STEP_UP_CONFIRMED', from: 'STEP_UP_PENDING', to: 'APPROVED' });
    await emitStepUp(client, row, 'CONFIRMED');
    await addEvent(client, 'transaction_updated', row.txn_id, { txn_id: row.txn_id, status: 'APPROVED', reason_codes: row.reason_codes });
    return { result: { status: 'APPROVED', reason_codes: row.reason_codes, alert_id: null } };
  });
  notifyCommitted();
  if (outcome.error) throw outcome.error;
  return { step_up_id: Number(stepUpId), ...outcome.result };
}

// Scheduled job: expire pending step-ups whose expiry has passed. SKIP LOCKED lets several replicas run it safely.
async function expireDue(limit = 50) {
  const expired = await withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT step_up_id FROM step_ups WHERE status = 'PENDING' AND expires_at <= now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    if (!rows.length) return [];
    const cfg = await loadConfig(client);
    const out = [];
    for (const { step_up_id: id } of rows) {
      const row = (await client.query(LOCK_SQL, [id])).rows[0];
      out.push({ step_up_id: id, ...(await blockStepUp(client, row, 'STEP_UP_TIMEOUT', { id: 'system', role: 'SYSTEM' }, cfg)) });
    }
    return out;
  });
  if (expired.length) {
    log.info('step-ups expired', { count: expired.length });
    notifyCommitted();
  }
  return expired;
}

module.exports = { respond, expireDue };
