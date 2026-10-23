// G. Performance: sequential velocity run, sustained load with latency percentiles against the SLA
// (p95 < 300 ms with the model, < 150 ms rules-only), concurrent load, and the 300-row batch in 60 s.
// Uses the real model service when reachable, otherwise the stub (reported in the test output).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const { toIstIso } = require('../src/engine/time');
const { runBatch } = require('../src/cli/batch');

let app;
let stub;
let modelLabel;
before(async () => {
  await h.resetDb();
  stub = await h.startStubModel();
  const real = await h.mlReachable();
  h.setMlUrl(real ? h.REAL_ML_URL : stub.url);
  modelLabel = real ? 'real XGBoost service' : 'stub model (real service not reachable)';
  app = await h.startApp();
});
after(async () => {
  await app.close();
  await stub.close();
});

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const CARDS = Array.from({ length: 20 }, (_, i) => `C${2011 + i}`);
let clock = Date.parse('2026-03-05T10:00:00+05:30');
// Spread cards and timestamps so velocity rules do not fire during the load test.
const loadTxn = (i) => h.txn({ card_id: CARDS[i % CARDS.length], amount: '250.00', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM', txn_ts: toIstIso((clock += 61000)) });

test('sequential velocity run through the simulator: 3 APPROVE, 2 STEP_UP, then VELOCITY_BURST', async () => {
  const token = await h.login(app.url, 'analyst1');
  const out = [];
  for (let i = 0; i < 6; i++) {
    const r = await h.call(app.url, 'POST', '/api/v1/simulator/transactions', { token,
      body: { card_id: 'C1001', txn_ts: 'now', amount: '3500.00', currency: 'INR', merchant_id: 'M00450', mcc: '5411', channel: 'POS', txn_city: 'Mumbai', txn_country: 'IN' } });
    assert.equal(r.status, 201);
    out.push(r.body.rules_decision);
  }
  assert.deepEqual(out, ['APPROVE', 'APPROVE', 'APPROVE', 'STEP_UP', 'STEP_UP', 'BLOCK']);
});

test('sustained sequential load: p95 authorisation latency under 300 ms including the model', async (t) => {
  const lat = [];
  for (let i = 0; i < 200; i++) {
    const r = await h.authorise(app.url, loadTxn(i));
    assert.equal(r.status, 201);
    lat.push(r.ms);
  }
  t.diagnostic(`${modelLabel}: 200 requests p50 ${pct(lat, 50).toFixed(1)} ms, p95 ${pct(lat, 95).toFixed(1)} ms, max ${Math.max(...lat).toFixed(1)} ms`);
  assert.ok(pct(lat, 95) < 300, `p95 ${pct(lat, 95)} ms`);
});

test('rules-only path: p95 under 150 ms', async (t) => {
  await h.setConfig('ai_enabled', false);
  const lat = [];
  for (let i = 0; i < 200; i++) lat.push((await h.authorise(app.url, loadTxn(i))).ms);
  await h.setConfig('ai_enabled', true);
  t.diagnostic(`rules-only: p50 ${pct(lat, 50).toFixed(1)} ms, p95 ${pct(lat, 95).toFixed(1)} ms`);
  assert.ok(pct(lat, 95) < 150, `p95 ${pct(lat, 95)} ms`);
});

test('concurrent load: 10 parallel clients x 20 requests, p95 under 300 ms', async (t) => {
  let i = 0;
  const lat = [];
  await Promise.all(Array.from({ length: 10 }, async () => {
    for (let k = 0; k < 20; k++) {
      const r = await h.authorise(app.url, loadTxn(i++));
      assert.equal(r.status, 201);
      lat.push(r.ms);
    }
  }));
  t.diagnostic(`${modelLabel}, 10 clients: p50 ${pct(lat, 50).toFixed(1)} ms, p95 ${pct(lat, 95).toFixed(1)} ms`);
  assert.ok(pct(lat, 95) < 300, `p95 ${pct(lat, 95)} ms`);
});

test('a 300-row batch completes within 60 seconds', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-batch-'));
  const file = path.join(dir, 'batch.csv');
  const lines = ['txn_id,card_id,txn_ts,amount,currency,merchant_id,mcc,channel,txn_city,txn_country'];
  let ts = Date.parse('2026-03-06T00:00:00+05:30');
  for (let i = 0; i < 300; i++) {
    const card = CARDS[i % CARDS.length];
    lines.push(`T6${String(i).padStart(8, '0')},${card},${toIstIso((ts += 37000))},${(100 + i).toFixed(2)},INR,M00451,5732,ECOM,Mumbai,IN`);
  }
  fs.writeFileSync(file, lines.join('\n'));
  const r = await runBatch({ file, outDir: dir, reset: false, log: () => {} });
  t.diagnostic(`300 rows in ${r.processing_ms} ms`);
  assert.equal(r.processed, 300);
  assert.ok(r.processing_ms < 60000);
  const out = fs.readFileSync(path.join(dir, 'decisions_output.csv'), 'utf8').trim().split('\n');
  assert.equal(out.length, 301);
  assert.equal(out[0], 'txn_id,decision,reason_codes,rule_risk_score,velocity_10m,avg_amount_30d,speed_kmph');
});
