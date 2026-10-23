// A. API and security: gateway key, validation, idempotency, role checks, object-level access.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

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

test('valid authorisation returns 201 with every required response field', async () => {
  const r = await h.authorise(app.url, h.txn());
  assert.equal(r.status, 201);
  for (const k of ['txn_id', 'decision', 'reason_codes', 'rule_risk_score', 'status', 'alert_id', 'processed_at', 'fraud_score', 'top_factors', 'model_status']) {
    assert.ok(k in r.body, `missing ${k}`);
  }
  assert.equal(r.body.decision, 'APPROVE');
  assert.equal(r.body.status, 'APPROVED');
  assert.ok(Array.isArray(r.body.reason_codes));
  assert.match(r.body.processed_at, /\+05:30$/);
});

test('missing or wrong gateway API key returns 401', async () => {
  const none = await h.call(app.url, 'POST', '/api/v1/authorisations', { body: h.txn() });
  const wrong = await h.call(app.url, 'POST', '/api/v1/authorisations', { apiKey: 'wrong-key', body: h.txn() });
  assert.equal(none.status, 401);
  assert.equal(wrong.status, 401);
});

test('a staff JWT cannot call the gateway API and the gateway key cannot call user APIs', async () => {
  const token = await h.login(app.url, 'analyst1');
  assert.equal((await h.call(app.url, 'POST', '/api/v1/authorisations', { token, body: h.txn() })).status, 401);
  assert.equal((await h.call(app.url, 'GET', '/api/v1/alerts', { apiKey: h.env.gatewayApiKey })).status, 401);
});

test('invalid payload returns 422 listing each invalid field', async () => {
  const r = await h.authorise(app.url, { txn_id: 'X1', card_id: 'C1001', txn_ts: '2026-03-04T14:05:00Z', amount: 0, currency: 'USD', merchant_id: 'M99999',
    mcc: '54', channel: 'PHONE', txn_city: 'Atlantis', txn_country: 'IN' });
  assert.equal(r.status, 422);
  const fields = r.body.fields.map((f) => f.field).sort();
  assert.deepEqual(fields, ['amount', 'channel', 'currency', 'mcc', 'merchant_id', 'txn_city', 'txn_id', 'txn_ts']);
});

test('amount limits, decimals and city/country consistency are validated', async () => {
  const bad = async (o) => (await h.authorise(app.url, h.txn(o))).body.fields.map((f) => f.field);
  assert.deepEqual(await bad({ amount: '1000000.01' }), ['amount']);
  assert.deepEqual(await bad({ amount: '10.123' }), ['amount']);
  assert.deepEqual(await bad({ txn_country: 'SG' }), ['txn_country']);
  assert.equal((await h.authorise(app.url, h.txn({ amount: '1000000.00', card_id: 'C2013' }))).status, 201);
});

test('unknown card returns 422 and malformed JSON returns 400', async () => {
  assert.equal((await h.authorise(app.url, h.txn({ card_id: 'C9999' }))).status, 422);
  const r = await h.call(app.url, 'POST', '/api/v1/authorisations', { apiKey: h.env.gatewayApiKey, raw: '{"txn_id": ' });
  assert.equal(r.status, 400);
});

test('repeated txn_id returns the original response and creates no second record (FR-2)', async () => {
  const body = h.txn({ card_id: 'C2014', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM', amount: '500.00' });
  const first = await h.authorise(app.url, body);
  const second = await h.authorise(app.url, body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(second.body, first.body);
  const count = await h.db.query('SELECT count(*)::int AS n FROM transactions WHERE txn_id = $1', [body.txn_id]);
  const audits = await h.db.query("SELECT count(*)::int AS n FROM audit_events WHERE entity = 'TRANSACTION' AND entity_id = $1 AND action = 'AUTHORISATION_DECISION'", [body.txn_id]);
  assert.equal(count.rows[0].n, 1);
  assert.equal(audits.rows[0].n, 1);
  // velocity_10m does not double: the next transaction sees exactly one earlier transaction
  const next = await h.authorise(app.url, h.txn({ card_id: 'C2014', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM', amount: '500.00', txn_ts: '2026-03-04T14:06:00+05:30' }));
  assert.equal(next.body.features.velocity_10m, 1);
});

test('repeated txn_id with a different payload returns 409', async () => {
  const body = h.txn({ card_id: 'C2015' });
  await h.authorise(app.url, body);
  const r = await h.authorise(app.url, { ...body, amount: '9999.00' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'IDEMPOTENCY_CONFLICT');
});

test('same txn_id sent concurrently creates exactly one transaction', async () => {
  const body = h.txn({ card_id: 'C2016' });
  const res = await Promise.all(Array.from({ length: 5 }, () => h.authorise(app.url, body)));
  assert.equal(res.filter((r) => r.status === 201).length, 1);
  assert.equal(res.filter((r) => r.status === 200).length, 4);
  const count = await h.db.query('SELECT count(*)::int AS n FROM transactions WHERE txn_id = $1', [body.txn_id]);
  assert.equal(count.rows[0].n, 1);
});

test('login: wrong password returns 401; the role comes from the server', async () => {
  const bad = await h.call(app.url, 'POST', '/api/v1/auth/login', { body: { username: 'manager1', password: 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await h.call(app.url, 'POST', '/api/v1/auth/login', { body: { username: 'analyst1', password: h.env.demoPassword, role: 'MANAGER' } });
  assert.equal(ok.body.user.role, 'ANALYST');
});

test('requests without a token return 401', async () => {
  assert.equal((await h.call(app.url, 'GET', '/api/v1/alerts')).status, 401);
  assert.equal((await h.call(app.url, 'GET', '/api/v1/alerts', { token: 'not-a-jwt' })).status, 401);
});

test('a cardholder calling analyst or manager APIs receives 403 (FR-1)', async () => {
  const token = await h.login(app.url, 'holder_c1001');
  for (const [m, p] of [['GET', '/api/v1/alerts'], ['GET', '/api/v1/transactions'], ['GET', '/api/v1/dashboard/summary'], ['POST', '/api/v1/alerts/1/claim'],
    ['GET', '/api/v1/audit/TRANSACTION/T1'], ['PUT', '/api/v1/config/velocity_burst_count']]) {
    assert.equal((await h.call(app.url, m, p, { token, body: m === 'GET' ? undefined : {} })).status, 403, `${m} ${p}`);
  }
});

test('an analyst cannot use manager-only operations (403)', async () => {
  const token = await h.login(app.url, 'analyst1');
  assert.equal((await h.call(app.url, 'POST', '/api/v1/alerts/1/manager-decision', { token, body: { decision: 'APPROVE', comment: 'long enough comment' } })).status, 403);
  assert.equal((await h.call(app.url, 'PUT', '/api/v1/config/velocity_burst_count', { token, body: { value: 4 } })).status, 403);
  assert.equal((await h.call(app.url, 'POST', '/api/v1/demo/reset', { token, body: { confirm: 'RESET' } })).status, 403);
});

test('a manager cannot claim or close alerts (analyst-only actions)', async () => {
  const token = await h.login(app.url, 'manager1');
  assert.equal((await h.call(app.url, 'POST', '/api/v1/alerts/1/claim', { token })).status, 403);
});

test("changing the id in the URL does not expose another cardholder's data", async () => {
  const own = h.txn({ card_id: 'C2017' });
  const other = h.txn({ card_id: 'C2018' });
  await h.authorise(app.url, own);
  await h.authorise(app.url, other);
  const token = await h.login(app.url, 'holder_c2017');
  assert.equal((await h.call(app.url, 'GET', `/api/v1/me/transactions/${own.txn_id}`, { token })).status, 200);
  assert.equal((await h.call(app.url, 'GET', `/api/v1/me/transactions/${other.txn_id}`, { token })).status, 404);
  assert.equal((await h.call(app.url, 'POST', '/api/v1/me/cards/C2018/block', { token })).status, 404);
  const list = await h.call(app.url, 'GET', '/api/v1/me/transactions', { token });
  assert.ok(list.body.transactions.every((t) => t.card_id === 'C2017'));
});

test('in demo mode the standalone simulator works without a login and uses the same authorisation service', async () => {
  const r = await h.call(app.url, 'POST', '/api/v1/simulator/transactions', { body: { card_id: 'C2019', txn_ts: 'now', amount: '500.00', currency: 'INR',
    merchant_id: 'M00450', mcc: '5411', channel: 'POS', txn_city: 'Mumbai', txn_country: 'IN' } });
  assert.equal(r.status, 201);
  assert.match(r.body.txn_id, /^T\d{9}$/);
  assert.equal(r.body.decision, 'APPROVE');
  const audit = await h.db.query("SELECT actor, role FROM audit_events WHERE entity = 'TRANSACTION' AND entity_id = $1", [r.body.txn_id]);
  assert.deepEqual(audit.rows[0], { actor: 'simulator', role: 'SIMULATOR' });
  // an invalid token is still rejected, and the gateway endpoint itself still needs the API key
  assert.equal((await h.call(app.url, 'GET', '/api/v1/simulator/options', { token: 'bad' })).status, 401);
  assert.equal((await h.call(app.url, 'POST', '/api/v1/authorisations', { body: h.txn() })).status, 401);
});

test('full card numbers are never stored or returned; only the last 4 digits', async () => {
  const cols = await h.db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'cards'");
  assert.equal(cols.rows.some((c) => /card_number|pan/.test(c.column_name)), false);
  const leak = await h.db.query("SELECT count(*)::int AS n FROM cards WHERE card_hash ~ '^9999' OR last4 !~ '^[0-9]{4}$'");
  assert.equal(leak.rows[0].n, 0);
  const token = await h.login(app.url, 'analyst1');
  const r = await h.call(app.url, 'GET', '/api/v1/cards/C1001', { token });
  assert.match(r.body.card.masked, /^X{12}\d{4}$/);
  assert.equal(/9999\d{12}/.test(r.text), false);
});
