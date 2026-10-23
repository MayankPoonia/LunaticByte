// C. XGBoost model: the real Flask service (skipped with a reason when it is not reachable) and the
// rules + model decision policy using a programmable stub (worked examples 13 and 14, fallback).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const FEATURES = { card_type: 'DEBIT', channel: 'ECOM', mcc: '6051', mcc_category: 'QUASI_CASH', merchant_risk: 'MEDIUM', amount: 45000, local_hour: 2,
  is_international: 0, country_risk_high: 0, distance_from_home_km: 0, velocity_10m: 0, velocity_24h: 0, amount_to_avg30_ratio: 18.75,
  new_merchant_flag: 1, card_age_days: 1144 };
const post = (url, body) => fetch(`${url}/predict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('real model service', async () => {
  const reachable = await h.mlReachable();
  const skip = reachable ? false : `model service not reachable at ${h.REAL_ML_URL}`;

  test('model loads at start-up and reports its version on /health', { skip }, async () => {
    const r = await (await fetch(`${h.REAL_ML_URL}/health`)).json();
    assert.equal(r.status, 'UP');
    assert.equal(r.model_loaded, true);
    assert.match(r.model_version, /^xgb-/);
  });

  test('valid prediction returns a probability, 3 plain-language factors and the version', { skip }, async () => {
    const r = await post(h.REAL_ML_URL, { features: FEATURES });
    const b = await r.json();
    assert.equal(r.status, 200);
    assert.ok(b.fraud_score >= 0 && b.fraud_score <= 1);
    assert.equal(b.top_factors.length, 3);
    assert.ok(b.top_factors.every((f) => typeof f.text === 'string' && f.text.length > 0));
    assert.equal(b.model_status, 'OK');
  });

  test('the same input always gives the same score (no retraining per request)', { skip }, async () => {
    const a = await (await post(h.REAL_ML_URL, { features: FEATURES })).json();
    const b = await (await post(h.REAL_ML_URL, { features: FEATURES })).json();
    assert.equal(a.fraud_score, b.fraud_score);
  });

  test('missing or invalid features return 422 with field names; bad JSON returns 400', { skip }, async () => {
    const r = await post(h.REAL_ML_URL, { features: { ...FEATURES, amount: -5, channel: undefined, local_hour: 30 } });
    const b = await r.json();
    assert.equal(r.status, 422);
    assert.deepEqual(b.fields.map((f) => f.field).sort(), ['amount', 'channel', 'local_hour']);
    const bad = await fetch(`${h.REAL_ML_URL}/predict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'nope' });
    assert.equal(bad.status, 400);
  });

  test('offline evaluation metadata: out-of-time split, seed 42, PR-AUC reported for model and baseline', { skip }, async () => {
    const info = await (await fetch(`${h.REAL_ML_URL}/model/info`)).json();
    assert.equal(info.seed, 42);
    assert.match(info.split, /2026-01-01/);
    assert.ok(info.metrics.xgboost.pr_auc > 0 && info.metrics.baseline.pr_auc > 0);
    assert.deepEqual(info.features.includes('txn_id') || info.features.includes('txn_ts') || info.features.includes('city_tier'), false);
  });

  test('rules-approved fraud examples from the labelled test set really score >= 0.70', { skip }, async (t) => {
    const info = await (await fetch(`${h.REAL_ML_URL}/model/info`)).json();
    const examples = info.rules_missed_examples || [];
    if (!examples.length) {
      t.skip('the labelled test period has no fraud with baseline score 0 and fraud_score >= 0.70');
      return;
    }
    for (const e of examples) {
      const r = await (await post(h.REAL_ML_URL, { features: e.features })).json();
      assert.equal(e.baseline_score, 0);
      assert.ok(r.fraud_score >= 0.7, `${e.txn_id} scored ${r.fraud_score}`);
      assert.ok(Math.abs(r.fraud_score - e.fraud_score) < 1e-3);
    }
  });

  test('end to end: authorisation calls the real model and stores score and version', { skip }, async () => {
    await h.resetDb();
    h.setMlUrl(h.REAL_ML_URL);
    const app = await h.startApp({ workers: false });
    try {
      const r = await h.authorise(app.url, h.txn());
      assert.equal(r.body.model_status, 'OK');
      assert.equal(typeof r.body.fraud_score, 'number');
      assert.match(r.body.model_version, /^xgb-/);
      assert.equal(r.body.top_factors.length, 3);
      const row = await h.db.query("SELECT model_version, features->'model' AS f FROM transactions WHERE txn_id = $1", [r.body.txn_id]);
      assert.equal(row.rows[0].model_version, r.body.model_version);
      assert.equal(row.rows[0].f.channel, 'POS');
    } finally {
      await app.close();
    }
  });
});

describe('decision policy with a programmable model stub', () => {
  let app;
  let stub;
  before(async () => {
    await h.resetDb();
    stub = await h.startStubModel();
    h.setMlUrl(stub.url);
    app = await h.startApp({ workers: false });
  });
  after(async () => {
    await app.close();
    await stub.close();
  });

  test('example 13: rules APPROVE + fraud_score 0.82 -> STEP_UP with HIGH_FRAUD_SCORE_MODEL; rules-only stays APPROVE', async () => {
    stub.score = () => 0.82;
    const r = await h.authorise(app.url, h.txn({ card_id: 'C1001' }));
    assert.deepEqual([r.body.decision, r.body.reason_codes, r.body.rules_decision, r.body.status], ['STEP_UP', ['HIGH_FRAUD_SCORE_MODEL'], 'APPROVE', 'STEP_UP_PENDING']);
    assert.equal(r.body.rule_risk_score, 0);
    stub.reset();
  });

  test('example 14: rules STEP_UP (HIGH_VELOCITY) + 0.93 -> BLOCK, codes HIGH_VELOCITY|HIGH_FRAUD_SCORE_MODEL, HIGH alert', async () => {
    stub.score = () => 0.93;
    const r = await h.authorise(app.url, h.txn({ card_id: 'C1009', amount: '1200.00', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM' }));
    assert.deepEqual([r.body.decision, r.body.reason_codes], ['BLOCK', ['HIGH_VELOCITY', 'HIGH_FRAUD_SCORE_MODEL']]);
    const a = await h.db.query('SELECT priority FROM alerts WHERE alert_id = $1', [r.body.alert_id]);
    assert.equal(a.rows[0].priority, 'HIGH');
    stub.reset();
  });

  test('the model never relaxes a decision and APPROVE escalates at most to STEP_UP', async () => {
    stub.score = () => 0.0;
    const block = await h.authorise(app.url, h.txn({ card_id: 'C2011', merchant_id: 'M00460', mcc: '5812' }));
    assert.equal(block.body.decision, 'BLOCK');
    const stepUp = await h.authorise(app.url, h.txn({ card_id: 'C1007', amount: '15000.00', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM' }));
    assert.equal(stepUp.body.decision, 'STEP_UP');
    stub.score = () => 0.99;
    const approve = await h.authorise(app.url, h.txn({ card_id: 'C1008' }));
    assert.equal(approve.body.decision, 'STEP_UP');
    stub.score = () => 0.69;
    assert.equal((await h.authorise(app.url, h.txn({ card_id: 'C1006', amount: '100.00' }))).body.decision, 'APPROVE');
    stub.reset();
  });

  test('model slower than 150 ms -> rules-only decision with MODEL_UNAVAILABLE, response still fast', async () => {
    stub.score = () => 0.99;
    stub.delayMs = 400;
    const r = await h.authorise(app.url, h.txn({ card_id: 'C2012' }));
    assert.deepEqual([r.body.decision, r.body.model_status, r.body.fraud_score], ['APPROVE', 'MODEL_UNAVAILABLE', null]);
    assert.ok(r.ms < 300, `took ${r.ms} ms`);
    stub.reset();
  });

  test('model error or service down -> MODEL_UNAVAILABLE and rules-only decision', async () => {
    stub.fail = true;
    const r1 = await h.authorise(app.url, h.txn({ card_id: 'C2013' }));
    assert.equal(r1.body.model_status, 'MODEL_UNAVAILABLE');
    stub.reset();
    h.setMlUrl('http://127.0.0.1:9');
    const r2 = await h.authorise(app.url, h.txn({ card_id: 'C2014' }));
    assert.deepEqual([r2.body.decision, r2.body.model_status], ['APPROVE', 'MODEL_UNAVAILABLE']);
    h.setMlUrl(stub.url);
  });

  test('the AI kill switch (ai_enabled = false) skips the model and records DISABLED', async () => {
    await h.setConfig('ai_enabled', false);
    stub.score = () => 0.99;
    const calls = stub.calls;
    const r = await h.authorise(app.url, h.txn({ card_id: 'C2015' }));
    assert.deepEqual([r.body.decision, r.body.model_status], ['APPROVE', 'DISABLED']);
    assert.equal(stub.calls, calls);
    await h.setConfig('ai_enabled', true);
    stub.reset();
  });

  test('AI thresholds are configuration: lowering ai_step_up_threshold to 0.5 escalates a 0.6 score', async () => {
    await h.setConfig('ai_step_up_threshold', 0.5);
    stub.score = () => 0.6;
    const r = await h.authorise(app.url, h.txn({ card_id: 'C2016' }));
    assert.equal(r.body.decision, 'STEP_UP');
    await h.setConfig('ai_step_up_threshold', 0.7);
    stub.reset();
  });

  test('the model receives the case-study features and no card number or customer data', async () => {
    let seen = null;
    stub.score = (f) => {
      seen = f;
      return 0.1;
    };
    await h.authorise(app.url, h.txn({ card_id: 'C1001', txn_ts: '2026-03-04T14:30:00+05:30' }));
    assert.deepEqual(Object.keys(seen).sort(), ['amount', 'amount_to_avg30_ratio', 'card_age_days', 'card_type', 'channel', 'country_risk_high',
      'distance_from_home_km', 'is_international', 'local_hour', 'mcc', 'mcc_category', 'merchant_risk', 'new_merchant_flag', 'velocity_10m', 'velocity_24h']);
    assert.equal(seen.local_hour, 14);
    assert.equal(seen.distance_from_home_km, 0);
    stub.reset();
  });
});
