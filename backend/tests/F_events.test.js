// F. Events and recovery: outbox -> Redis Stream -> Socket.IO, room authorisation, reconnection,
// duplicate delivery, Redis outage after a committed decision, outbox retry.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const h = require('./helpers');
const { createConsumer } = require('../src/events/consumer');
const { createPublisher } = require('../src/events/publisher');
const { createRedis } = require('../src/redis');

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

function socketFor(token) {
  const s = connect(app.url, { path: '/socket.io', transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true });
  s.events = [];
  s.on('event', (e) => s.events.push(e));
  return new Promise((resolve, reject) => {
    s.on('ready', () => resolve(s));
    s.on('connect_error', reject);
  });
}

test('staff dashboard receives transaction_decided and alert_created within 5 seconds of the decision', async () => {
  const s = await socketFor(await h.login(app.url, 'analyst1'));
  const started = Date.now();
  const r = await h.authorise(app.url, h.txn({ card_id: 'C1005', amount: '4000.00', merchant_id: 'M00454', txn_city: 'Delhi' }));
  await h.waitFor(() => s.events.some((e) => e.type === 'alert_created' && e.payload.alert_id === r.body.alert_id), 5000);
  const elapsed = Date.now() - started;
  assert.ok(s.events.some((e) => e.type === 'transaction_decided' && e.payload.txn_id === r.body.txn_id));
  assert.ok(elapsed < 5000, `alert visible after ${elapsed} ms`);
  assert.equal(/9999\d{12}/.test(JSON.stringify(s.events)), false, 'no card numbers in events');
  s.close();
});

test('a cardholder socket receives only its own step-up events, never staff events', async () => {
  const holder = await socketFor(await h.login(app.url, 'holder_c1007'));
  const other = await socketFor(await h.login(app.url, 'holder_c1008'));
  const r = await h.authorise(app.url, h.txn({ card_id: 'C1007', amount: '15000.00', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM' }));
  await h.waitFor(() => holder.events.some((e) => e.type === 'step_up_updated' && e.payload.txn_id === r.body.txn_id));
  await new Promise((res) => setTimeout(res, 500));
  assert.ok(holder.events.every((e) => e.type === 'step_up_updated' || e.type === 'card_updated'));
  assert.equal(other.events.length, 0);
  holder.close();
  other.close();
});

test('a socket without a valid token is rejected', async () => {
  await assert.rejects(() => socketFor('bad-token'), /unauthorized/);
});

test('after a reconnect the client recovers missed alerts through the REST refresh', async () => {
  const token = await h.login(app.url, 'analyst1');
  const s = await socketFor(token);
  s.close();
  const r = await h.authorise(app.url, h.txn({ card_id: 'C2011', merchant_id: 'M00460', mcc: '5812' }));
  const again = await socketFor(token);
  const list = await h.call(app.url, 'GET', '/api/v1/alerts', { token });
  assert.ok(list.body.alerts.some((a) => a.alert_id === r.body.alert_id));
  again.close();
});

test('duplicate stream deliveries are handled once (idempotent consumer)', async () => {
  const delivered = [];
  const fakeRedis = { xack: async () => 1 };
  const c = createConsumer(fakeRedis, (e) => delivered.push(e), { streamKey: 'x', group: 'g' });
  const entry = ['1-0', ['event_id', '42', 'type', 'alert_created', 'audience', 'staff', 'created_at', new Date().toISOString(), 'payload', '{"alert_id":1}']];
  await c.handle([entry]);
  await c.handle([entry]);
  assert.equal(delivered.length, 1);
});

test('Redis down after a committed decision: the decision is returned, the event waits in the outbox, then publishes', async () => {
  app.publisher.stop(); // only the publishers created below may touch the outbox in this test
  const down = createRedis('down', 'redis://127.0.0.1:6390');
  try {
    const r = await h.authorise(app.url, h.txn({ card_id: 'C2012' }));
    assert.equal(r.status, 201, 'the decision does not depend on Redis');
    const failed = await createPublisher(down).publishOnce();
    assert.ok(failed.failed >= 1);
    const row = await h.db.query('SELECT published_at, attempts, last_error FROM outbox_events WHERE aggregate_id = $1', [r.body.txn_id]);
    assert.equal(row.rows[0].published_at, null);
    assert.ok(row.rows[0].attempts >= 1);
    assert.ok(row.rows[0].last_error);

    // Redis is back: the retry publishes the event exactly once
    const healthy = createPublisher(app.redis);
    await healthy.publishOnce();
    const published = await h.db.query('SELECT event_id, published_at FROM outbox_events WHERE aggregate_id = $1', [r.body.txn_id]);
    assert.ok(published.rows[0].published_at);
    await healthy.publishOnce();
    const eventId = String(published.rows[0].event_id);
    const entries = await app.redis.xrange(h.env.streamKey, '-', '+');
    assert.equal(entries.filter(([, f]) => f[1] === eventId).length, 1);
  } finally {
    down.disconnect();
    app.publisher.start();
  }
});

test('event delivery latency is measured by the consumer', async () => {
  const stats = app.consumer.stats();
  assert.ok(stats.delivered > 0);
  assert.ok(stats.p95_ms < 5000);
});
