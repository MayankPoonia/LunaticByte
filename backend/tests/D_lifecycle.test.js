// D. Transaction lifecycle: APPROVE, STEP_UP -> CONFIRM / NOT_ME / timeout, card blocking, idempotent retries.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const stepUps = require('../src/services/stepUps');

let app;
let stub;
before(async () => {
  await h.resetDb();
  stub = await h.startStubModel();
  h.setMlUrl(stub.url);
  app = await h.startApp();
});
after(async () => {
  await app.close();
  await stub.close();
});

// Worked example 7 on a given card: INR 15,000 ECOM at the known merchant M00451 -> STEP_UP (AMOUNT_SPIKE).
const spike = (card) => h.txn({ card_id: card, amount: '15000.00', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM' });

async function otpFor(token, txnId) {
  const r = await h.call(app.url, 'GET', '/api/v1/me/notifications', { token });
  const n = r.body.notifications.find((x) => x.txn_id === txnId && x.kind === 'STEP_UP_OTP');
  return n.message.match(/OTP (\d{6})/)[1];
}

async function stepUpFor(token, txnId) {
  const r = await h.call(app.url, 'GET', '/api/v1/me/step-ups', { token });
  return r.body.step_ups.find((s) => s.txn_id === txnId);
}

test('APPROVE: status APPROVED and the audit trail records RECEIVED -> APPROVED', async () => {
  const t = h.txn({ card_id: 'C1001' });
  const r = await h.authorise(app.url, t);
  assert.equal(r.body.status, 'APPROVED');
  const a = await h.db.query("SELECT from_status, to_status FROM audit_events WHERE entity = 'TRANSACTION' AND entity_id = $1", [t.txn_id]);
  assert.deepEqual(a.rows, [{ from_status: 'RECEIVED', to_status: 'APPROVED' }]);
});

test('STEP_UP -> CONFIRM with the correct OTP -> APPROVED (worked example 7)', async () => {
  const t = spike('C1007');
  const r = await h.authorise(app.url, t);
  assert.deepEqual([r.body.decision, r.body.status, r.body.reason_codes, r.body.rule_risk_score], ['STEP_UP', 'STEP_UP_PENDING', ['AMOUNT_SPIKE'], 30]);
  assert.ok(r.body.step_up.expires_at);
  const token = await h.login(app.url, 'holder_c1007');
  const s = await stepUpFor(token, t.txn_id);
  assert.equal(s.status, 'PENDING');
  const res = await h.call(app.url, 'POST', `/api/v1/me/step-ups/${s.step_up_id}/respond`, { token, body: { response: 'CONFIRM', otp: await otpFor(token, t.txn_id) } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'APPROVED');
  const row = await h.db.query('SELECT status FROM transactions WHERE txn_id = $1', [t.txn_id]);
  assert.equal(row.rows[0].status, 'APPROVED');
  // a second response is rejected
  const again = await h.call(app.url, 'POST', `/api/v1/me/step-ups/${s.step_up_id}/respond`, { token, body: { response: 'NOT_ME' } });
  assert.equal(again.status, 409);
});

test('wrong OTP returns 422 with attempts left; after the maximum the request is locked (409)', async () => {
  const t = spike('C2001');
  await h.authorise(app.url, t);
  const token = await h.login(app.url, 'holder_c2001');
  const s = await stepUpFor(token, t.txn_id);
  const otp = await otpFor(token, t.txn_id);
  const wrong = otp === '000000' ? '111111' : '000000';
  for (let i = 0; i < 3; i++) {
    const r = await h.call(app.url, 'POST', `/api/v1/me/step-ups/${s.step_up_id}/respond`, { token, body: { response: 'CONFIRM', otp: wrong } });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'INVALID_OTP');
  }
  const locked = await h.call(app.url, 'POST', `/api/v1/me/step-ups/${s.step_up_id}/respond`, { token, body: { response: 'CONFIRM', otp } });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, 'TOO_MANY_ATTEMPTS');
  const malformed = await h.call(app.url, 'POST', `/api/v1/me/step-ups/${s.step_up_id}/respond`, { token, body: { response: 'CONFIRM', otp: '12' } });
  assert.equal(malformed.status, 422);
});

test('STEP_UP -> NOT_ME -> BLOCKED (STEP_UP_DENIED), card BLOCKED, HIGH alert, later transactions blocked by R1 (example 11)', async () => {
  const t = spike('C2002');
  await h.authorise(app.url, t);
  const token = await h.login(app.url, 'holder_c2002');
  const s = await stepUpFor(token, t.txn_id);
  const r = await h.call(app.url, 'POST', `/api/v1/me/step-ups/${s.step_up_id}/respond`, { token, body: { response: 'NOT_ME' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.status, r.body.reason_codes, r.body.alert_priority], ['BLOCKED', ['AMOUNT_SPIKE', 'STEP_UP_DENIED'], 'HIGH']);
  const card = await h.db.query("SELECT card_status FROM cards WHERE card_id = 'C2002'");
  assert.equal(card.rows[0].card_status, 'BLOCKED');
  const next = await h.authorise(app.url, h.txn({ card_id: 'C2002', txn_ts: '2026-03-04T15:00:00+05:30' }));
  assert.deepEqual([next.body.decision, next.body.reason_codes, next.body.alert_id], ['BLOCK', ['CARD_NOT_ACTIVE'], null]);
});

test('no response before expiry -> BLOCKED (STEP_UP_TIMEOUT), MEDIUM alert, card stays ACTIVE', async () => {
  const t = spike('C2003');
  await h.authorise(app.url, t);
  await h.db.query("UPDATE step_ups SET expires_at = now() - interval '1 second' WHERE txn_id = $1", [t.txn_id]);
  const expired = await stepUps.expireDue();
  assert.ok(expired.some((e) => e.reason_codes.includes('STEP_UP_TIMEOUT')));
  const row = await h.db.query('SELECT t.status, t.reason_codes, a.priority FROM transactions t JOIN alerts a ON a.txn_id = t.txn_id WHERE t.txn_id = $1', [t.txn_id]);
  assert.deepEqual([row.rows[0].status, row.rows[0].reason_codes, row.rows[0].priority], ['BLOCKED', ['AMOUNT_SPIKE', 'STEP_UP_TIMEOUT'], 'MEDIUM']);
  const card = await h.db.query("SELECT card_status FROM cards WHERE card_id = 'C2003'");
  assert.equal(card.rows[0].card_status, 'ACTIVE');
  // running the job again changes nothing
  assert.equal((await stepUps.expireDue()).length, 0);
});

test('responding after expiry returns 409 STEP_UP_EXPIRED and the transaction is blocked', async () => {
  const t = spike('C2004');
  await h.authorise(app.url, t);
  const token = await h.login(app.url, 'holder_c2004');
  const s = await stepUpFor(token, t.txn_id);
  const otp = await otpFor(token, t.txn_id);
  await h.db.query("UPDATE step_ups SET expires_at = now() - interval '1 second' WHERE txn_id = $1", [t.txn_id]);
  const r = await h.call(app.url, 'POST', `/api/v1/me/step-ups/${s.step_up_id}/respond`, { token, body: { response: 'CONFIRM', otp } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'STEP_UP_EXPIRED');
  const row = await h.db.query('SELECT status FROM transactions WHERE txn_id = $1', [t.txn_id]);
  assert.equal(row.rows[0].status, 'BLOCKED');
});

test("a cardholder cannot respond to another cardholder's step-up (404)", async () => {
  const t = spike('C2005');
  await h.authorise(app.url, t);
  const owner = await h.login(app.url, 'holder_c2005');
  const s = await stepUpFor(owner, t.txn_id);
  const intruder = await h.login(app.url, 'holder_c2006');
  const r = await h.call(app.url, 'POST', `/api/v1/me/step-ups/${s.step_up_id}/respond`, { token: intruder, body: { response: 'NOT_ME' } });
  assert.equal(r.status, 404);
});

test('retrying a STEP_UP transaction returns the original response and creates no second step-up', async () => {
  const t = spike('C2006');
  const first = await h.authorise(app.url, t);
  const retry = await h.authorise(app.url, t);
  assert.deepEqual(retry.body, first.body);
  const n = await h.db.query('SELECT count(*)::int AS n FROM step_ups WHERE txn_id = $1', [t.txn_id]);
  assert.equal(n.rows[0].n, 1);
});

test('a cardholder can block their own card; later transactions are blocked by R1', async () => {
  const token = await h.login(app.url, 'holder_c2007');
  const r = await h.call(app.url, 'POST', '/api/v1/me/cards/C2007/block', { token });
  assert.equal(r.status, 200);
  const next = await h.authorise(app.url, h.txn({ card_id: 'C2007' }));
  assert.deepEqual(next.body.reason_codes, ['CARD_NOT_ACTIVE']);
  const audit = await h.db.query("SELECT action, from_status, to_status FROM audit_events WHERE entity = 'CARD' AND entity_id = 'C2007'");
  assert.deepEqual(audit.rows, [{ action: 'CARD_BLOCKED', from_status: 'ACTIVE', to_status: 'BLOCKED' }]);
});

test('the cardholder sees a neutral message, not reason codes, scores or alerts', async () => {
  const t = h.txn({ card_id: 'C1005', amount: '4000.00', merchant_id: 'M00454', txn_city: 'Delhi' });
  const decided = await h.authorise(app.url, t);
  assert.deepEqual(decided.body.reason_codes, ['IMPOSSIBLE_TRAVEL']);
  const token = await h.login(app.url, 'holder_c1005');
  const r = await h.call(app.url, 'GET', `/api/v1/me/transactions/${t.txn_id}`, { token });
  assert.equal(r.body.transaction.message, 'Declined for your security. Our fraud team may contact you.');
  assert.equal(/IMPOSSIBLE_TRAVEL|fraud_score|rule_risk_score|alert/.test(JSON.stringify(r.body).replace('fraud team', '')), false);
});
