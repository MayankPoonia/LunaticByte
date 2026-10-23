// E. Alerts and concurrency: alert creation policy, queue order, SLA, claim/close locking,
// maker-checker and the append-only audit trail.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const alerts = require('../src/services/alerts');

let app;
let stub;
let analyst1;
let analyst2;
let manager;
before(async () => {
  await h.resetDb();
  stub = await h.startStubModel();
  h.setMlUrl(stub.url);
  app = await h.startApp();
  [analyst1, analyst2, manager] = await Promise.all(['analyst1', 'analyst2', 'manager1'].map((u) => h.login(app.url, u)));
});
after(async () => {
  await app.close();
  await stub.close();
});

// A fraud-suspicion block at the blacklisted merchant (R3) for a chosen amount.
async function fraudAlert(card, amount = '5000.00') {
  const r = await h.authorise(app.url, h.txn({ card_id: card, merchant_id: 'M00460', mcc: '5812', amount, channel: 'ECOM' }));
  assert.ok(r.body.alert_id, 'alert expected');
  return r.body.alert_id;
}
const claim = (token, id) => h.call(app.url, 'POST', `/api/v1/alerts/${id}/claim`, { token });
const close = (token, id, outcome, comment = 'Reviewed card history and merchant details') =>
  h.call(app.url, 'POST', `/api/v1/alerts/${id}/close`, { token, body: { outcome, comment } });

test('a fraud-suspicion block creates one HIGH alert with sla_due_at = created + 30 minutes (example 5)', async () => {
  const r = await h.authorise(app.url, h.txn({ card_id: 'C1005', amount: '4000.00', merchant_id: 'M00454', txn_city: 'Delhi' }));
  assert.deepEqual(r.body.reason_codes, ['IMPOSSIBLE_TRAVEL']);
  const a = await h.db.query('SELECT priority, status, extract(epoch FROM sla_due_at - created_at)::int AS sla FROM alerts WHERE alert_id = $1', [r.body.alert_id]);
  assert.deepEqual(a.rows[0], { priority: 'HIGH', status: 'OPEN', sla: 1800 });
});

test('MEDIUM alerts get 240 minutes; amount of 50,000 or more makes an alert HIGH', async () => {
  const medium = await fraudAlert('C2011', '5000.00');
  const high = await fraudAlert('C2012', '50000.00');
  const q = await h.db.query('SELECT alert_id, priority, extract(epoch FROM sla_due_at - created_at)::int AS sla FROM alerts WHERE alert_id = ANY($1) ORDER BY alert_id', [[medium, high]]);
  assert.deepEqual(q.rows.map((x) => [x.priority, x.sla]), [['MEDIUM', 14400], ['HIGH', 1800]]);
});

test('policy declines (CARD_NOT_ACTIVE, INTL_NOT_ENABLED, DAILY_LIMIT_EXCEEDED) create no alert', async () => {
  const blocked = await h.authorise(app.url, h.txn({ card_id: 'C1002' }));
  const intl = await h.authorise(app.url, h.txn({ card_id: 'C1003', merchant_id: 'M00453', mcc: '5311', txn_city: 'Singapore', txn_country: 'SG' }));
  const limit = await h.authorise(app.url, h.txn({ card_id: 'C1004', amount: '9500.00' }));
  assert.deepEqual([blocked.body.reason_codes, intl.body.reason_codes, limit.body.reason_codes], [['CARD_NOT_ACTIVE'], ['INTL_NOT_ENABLED'], ['DAILY_LIMIT_EXCEEDED']]);
  assert.deepEqual([blocked.body.alert_id, intl.body.alert_id, limit.body.alert_id], [null, null, null]);
});

test('the queue is ordered by priority then sla_due_at, and overdue alerts are SLA_BREACHED', async () => {
  const id = await fraudAlert('C2013');
  await h.db.query("UPDATE alerts SET sla_due_at = now() - interval '1 minute' WHERE alert_id = $1", [id]);
  const r = await h.call(app.url, 'GET', '/api/v1/alerts', { token: analyst1 });
  const list = r.body.alerts;
  const rank = (p) => (p === 'HIGH' ? 0 : 1);
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    assert.ok(rank(a.priority) < rank(b.priority) || (rank(a.priority) === rank(b.priority) && new Date(a.sla_due_at) <= new Date(b.sla_due_at)));
  }
  assert.equal(list.find((a) => a.alert_id === id).sla_breached, true);
});

test('two analysts claiming the same alert at the same time: one succeeds, the other gets 409', async () => {
  const id = await fraudAlert('C2014');
  const [a, b] = await Promise.all([claim(analyst1, id), claim(analyst2, id)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const row = await h.db.query('SELECT status, claimed_by FROM alerts WHERE alert_id = $1', [id]);
  assert.equal(row.rows[0].status, 'IN_REVIEW');
});

test('only the claiming analyst can close; closing needs a comment of at least 10 characters', async () => {
  const id = await fraudAlert('C2015');
  await claim(analyst1, id);
  assert.equal((await close(analyst2, id, 'CONFIRMED_FRAUD')).status, 409);
  const short = await close(analyst1, id, 'CONFIRMED_FRAUD', 'too short');
  assert.equal(short.status, 422);
  assert.equal(short.body.fields[0].field, 'comment');
  assert.equal((await close(analyst1, id, 'MAYBE')).status, 422);
});

test('CONFIRMED_FRAUD closes the alert and blocks the card', async () => {
  const id = await fraudAlert('C2016');
  await claim(analyst1, id);
  const r = await close(analyst1, id, 'CONFIRMED_FRAUD');
  assert.equal(r.body.status, 'CONFIRMED_FRAUD');
  const card = await h.db.query("SELECT card_status FROM cards WHERE card_id = 'C2016'");
  assert.equal(card.rows[0].card_status, 'BLOCKED');
  const fb = await h.db.query('SELECT label FROM model_feedback WHERE txn_id = (SELECT txn_id FROM alerts WHERE alert_id = $1)', [id]);
  assert.equal(fb.rows[0].label, 1);
});

test('two simultaneous closes of the same alert: exactly one succeeds', async () => {
  const id = await fraudAlert('C2017');
  await claim(analyst1, id);
  const [a, b] = await Promise.all([close(analyst1, id, 'FALSE_POSITIVE'), close(analyst1, id, 'CONFIRMED_FRAUD')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('FALSE_POSITIVE at or below INR 1,00,000 closes directly and logs a cardholder notification', async () => {
  const id = await fraudAlert('C2018', '100000.00');
  await claim(analyst1, id);
  const r = await close(analyst1, id, 'FALSE_POSITIVE');
  assert.equal(r.body.status, 'FALSE_POSITIVE');
  const n = await h.db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'FALSE_POSITIVE_NOTICE' AND card_id = 'C2018'");
  assert.equal(n.rows[0].n, 1);
});

test('maker-checker: FALSE_POSITIVE above INR 1,00,000 needs a different manager (example 12)', async () => {
  const id = await fraudAlert('C2019', '120000.00');
  await claim(analyst1, id);
  const proposed = await close(analyst1, id, 'FALSE_POSITIVE');
  assert.equal(proposed.body.status, 'PENDING_MANAGER_APPROVAL');
  const byAnalyst = await h.call(app.url, 'POST', `/api/v1/alerts/${id}/manager-decision`, { token: analyst1, body: { decision: 'APPROVE', comment: 'approving my own proposal' } });
  assert.equal(byAnalyst.status, 403);
  const shortComment = await h.call(app.url, 'POST', `/api/v1/alerts/${id}/manager-decision`, { token: manager, body: { decision: 'APPROVE', comment: 'ok' } });
  assert.equal(shortComment.status, 422);
  const ok = await h.call(app.url, 'POST', `/api/v1/alerts/${id}/manager-decision`, { token: manager, body: { decision: 'APPROVE', comment: 'Verified with cardholder by phone' } });
  assert.equal(ok.body.status, 'FALSE_POSITIVE');
  const again = await h.call(app.url, 'POST', `/api/v1/alerts/${id}/manager-decision`, { token: manager, body: { decision: 'REJECT', comment: 'second decision attempt' } });
  assert.equal(again.status, 409);
});

test('maker-checker: the proposer can never act as checker, even with a manager role (403)', async () => {
  const id = await fraudAlert('C2020', '150000.00');
  await claim(analyst1, id);
  await close(analyst1, id, 'FALSE_POSITIVE');
  const sameUser = { user_id: 'U-ANALYST-1', role: 'MANAGER', display_name: 'dual role' };
  await assert.rejects(() => alerts.managerDecision(id, sameUser, { decision: 'APPROVE', comment: 'self approval attempt' }), (err) => err.status === 403);
  const row = await h.db.query('SELECT status FROM alerts WHERE alert_id = $1', [id]);
  assert.equal(row.rows[0].status, 'PENDING_MANAGER_APPROVAL');
});

test('manager REJECT of a proposal confirms fraud and blocks the card', async () => {
  const id = await fraudAlert('C2021', '130000.00');
  await claim(analyst1, id);
  await close(analyst1, id, 'FALSE_POSITIVE');
  const r = await h.call(app.url, 'POST', `/api/v1/alerts/${id}/manager-decision`, { token: manager, body: { decision: 'REJECT', comment: 'Pattern matches known fraud ring' } });
  assert.equal(r.body.status, 'CONFIRMED_FRAUD');
  const card = await h.db.query("SELECT card_status FROM cards WHERE card_id = 'C2021'");
  assert.equal(card.rows[0].card_status, 'BLOCKED');
});

test('the audit trail is append-only: UPDATE and DELETE are rejected by the database', async () => {
  await assert.rejects(() => h.db.query("UPDATE audit_events SET comment = 'tampered'"), /append-only/);
  await assert.rejects(() => h.db.query('DELETE FROM audit_events'), /append-only/);
});

test('audit view for a transaction shows its full history in order, and exports as CSV', async () => {
  const id = await fraudAlert('C2022');
  await claim(analyst1, id);
  await close(analyst1, id, 'CONFIRMED_FRAUD');
  const txnId = (await h.db.query('SELECT txn_id FROM alerts WHERE alert_id = $1', [id])).rows[0].txn_id;
  const r = await h.call(app.url, 'GET', `/api/v1/audit/TRANSACTION/${txnId}`, { token: manager });
  assert.deepEqual(r.body.events.map((e) => e.action), ['AUTHORISATION_DECISION', 'ALERT_CREATED', 'ALERT_CLAIMED', 'ALERT_CLOSED']);
  const ids = r.body.events.map((e) => Number(e.audit_id));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  const csv = await h.call(app.url, 'GET', `/api/v1/audit/TRANSACTION/${txnId}?format=csv`, { token: manager });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.equal(csv.text.trim().split('\n').length, 5);
  const cardAudit = await h.call(app.url, 'GET', '/api/v1/audit/CARD/C2022', { token: manager });
  assert.deepEqual(cardAudit.body.events.map((e) => e.to_status), ['BLOCKED']);
});

test('configuration changes are audited with before and after values', async () => {
  await h.call(app.url, 'PUT', '/api/v1/config/maker_checker_limit', { token: manager, body: { value: 200000 } });
  const r = await h.call(app.url, 'GET', '/api/v1/audit/CONFIG/maker_checker_limit', { token: manager });
  assert.deepEqual([r.body.events[0].details.before, r.body.events[0].details.after], [100000, 200000]);
  const bad = await h.call(app.url, 'PUT', '/api/v1/config/maker_checker_limit', { token: manager, body: { value: 'lots' } });
  assert.equal(bad.status, 422);
  await h.call(app.url, 'PUT', '/api/v1/config/maker_checker_limit', { token: manager, body: { value: 100000 } });
});

test('dashboard figures reconcile with the underlying data (FR-9)', async () => {
  const r = await h.call(app.url, 'GET', '/api/v1/dashboard/summary', { token: manager });
  const t = await h.db.query("SELECT decision, count(*)::int AS n FROM transactions WHERE source <> 'HISTORY' GROUP BY decision");
  for (const row of t.rows) assert.equal(r.body.transactions.by_decision[row.decision], row.n);
  const open = await h.db.query("SELECT count(*)::int AS n FROM alerts WHERE status IN ('OPEN','IN_REVIEW','PENDING_MANAGER_APPROVAL')");
  const sum = Object.values(r.body.alerts.open_by_priority).reduce((a, b) => a + b, 0);
  assert.equal(sum, open.rows[0].n);
  const fp = await h.db.query("SELECT count(*) FILTER (WHERE status = 'FALSE_POSITIVE')::float / NULLIF(count(*), 0) AS rate FROM alerts WHERE status IN ('FALSE_POSITIVE','CONFIRMED_FRAUD')");
  assert.equal(r.body.rates.false_positive_rate.toFixed(6), Number(fp.rows[0].rate).toFixed(6));
  assert.ok(r.body.top_reason_codes.length <= 5);
});
