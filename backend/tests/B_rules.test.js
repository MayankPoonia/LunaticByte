// B. Rules engine: every rule R1-R13, boundaries, precedence, velocity windows, configuration,
// and concurrent transactions on one card.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { computeFeatures } = require('../src/engine/features');
const { evaluateRules } = require('../src/engine/rules');
const { DEFAULTS } = require('../src/services/ruleConfig');

const cfg = { ...DEFAULTS };
const refs = {
  cities: new Map(h.fx.CITIES.map(([city, country, lat, lon, tier]) => [city, { city, country, lat, lon, city_tier: tier }])),
  countryRisk: new Map(h.fx.COUNTRIES.map(([code, , risk]) => [code, risk])),
  mcc: new Map(h.fx.MCCS.map(([mcc, d, cat, hr]) => [mcc, { mcc, mcc_category: cat, high_risk: hr }])),
  merchants: new Map(h.fx.MERCHANTS.map(([id, name, mcc, city, country, risk]) => [id, { merchant_id: id, merchant_name: name, mcc, city, country, merchant_risk: risk }])),
};
const T0 = Date.parse('2026-03-04T14:05:00+05:30');
const MIN = 60000;
const card = (o = {}) => ({ card_id: 'X', card_status: 'ACTIVE', expiry_date: '2029-12-31', international_enabled: false, daily_limit: 100000,
  home_city: 'Mumbai', home_country: 'IN', issue_date: '2023-01-15', card_type: 'DEBIT', ...o });
const tx = (o = {}) => ({ ts: T0, amount: '3500.00', merchant_id: 'M00450', mcc: '5411', channel: 'POS', txn_city: 'Mumbai', txn_country: 'IN', ...o });
// 20 approved 2,400 purchases in the previous 28 days -> avg_amount_30d 2,400
const baseHistory = () => Array.from({ length: 20 }, (_, k) => ({ ts: T0 - (28 - k) * 86400000 - 3 * 3600000, amount: '2400.00', status: 'APPROVED',
  merchant_id: k % 2 ? 'M00451' : 'M00450', channel: k % 2 ? 'ECOM' : 'POS', txn_city: 'Mumbai' }));

function run(t, c = card(), priors = baseHistory(), conf = cfg) {
  const f = computeFeatures(t, c, priors, refs, conf);
  return { ...evaluateRules(t, c, refs.merchants.get(t.merchant_id), f, refs, conf), f };
}

describe('hard stops R1-R2', () => {
  test('R1 card not active blocks with only CARD_NOT_ACTIVE and empty score', () => {
    const r = run(tx(), card({ card_status: 'BLOCKED' }));
    assert.equal(r.decision, 'BLOCK');
    assert.deepEqual(r.reason_codes, ['CARD_NOT_ACTIVE']);
    assert.equal(r.rule_risk_score, null);
    assert.equal(r.hard_stop, true);
  });
  test('R1 expiry earlier than transaction date blocks; expiry on the same day does not', () => {
    assert.deepEqual(run(tx(), card({ expiry_date: '2026-03-03' })).reason_codes, ['CARD_NOT_ACTIVE']);
    assert.equal(run(tx(), card({ expiry_date: '2026-03-04' })).decision, 'APPROVE');
  });
  test('R2 international transaction on a card without international use blocks', () => {
    const r = run(tx({ merchant_id: 'M00453', mcc: '5311', txn_city: 'Singapore', txn_country: 'SG' }));
    assert.deepEqual(r.reason_codes, ['INTL_NOT_ENABLED']);
    assert.equal(r.rule_risk_score, null);
  });
  test('R2 does not trigger when international use is enabled', () => {
    const r = run(tx({ merchant_id: 'M00453', mcc: '5311', txn_city: 'Singapore', txn_country: 'SG', channel: 'ECOM' }), card({ international_enabled: true }));
    assert.equal(r.reason_codes.includes('INTL_NOT_ENABLED'), false);
  });
  test('R1 and R2 together list both codes in rule order and stop evaluation', () => {
    const r = run(tx({ merchant_id: 'M00460', txn_city: 'Singapore', txn_country: 'SG', amount: '900000.00' }), card({ card_status: 'EXPIRED' }));
    assert.deepEqual(r.reason_codes, ['CARD_NOT_ACTIVE', 'INTL_NOT_ENABLED']);
    assert.equal(r.rules.some((x) => x.rule === 'R3'), false, 'R3+ must not be evaluated after a hard stop');
  });
});

describe('blocking rules R3-R6', () => {
  test('R3 blacklisted merchant blocks with score 100', () => {
    const r = run(tx({ merchant_id: 'M00460', mcc: '5812' }));
    assert.deepEqual(r.reason_codes, ['MERCHANT_BLACKLISTED']);
    assert.equal(r.rule_risk_score, 100);
  });
  test('R4 approved_today + amount above daily limit blocks (worked example 4)', () => {
    const priors = [...baseHistory(), { ts: T0 - 5 * 3600000 - 5 * MIN, amount: '92000.00', status: 'APPROVED', merchant_id: 'M00450', channel: 'POS', txn_city: 'Mumbai' }];
    const r = run(tx({ amount: '9500.00' }), card(), priors);
    assert.deepEqual(r.reason_codes, ['DAILY_LIMIT_EXCEEDED']);
    assert.equal(r.f.approved_today, 92000);
    assert.equal(r.f.avg_amount_30d.toFixed(2), '6666.67');
    assert.equal(r.f.speed_kmph, 0);
  });
  test('R4 boundary: approved_today + amount equal to the limit is allowed', () => {
    const priors = [{ ts: T0 - 60 * MIN, amount: '96500.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' }];
    assert.equal(run(tx({ amount: '3500.00' }), card(), priors).reason_codes.includes('DAILY_LIMIT_EXCEEDED'), false);
    assert.equal(run(tx({ amount: '3500.01' }), card(), priors).reason_codes.includes('DAILY_LIMIT_EXCEEDED'), true);
  });
  test('R4 approved_today counts only APPROVED amounts on the same IST date', () => {
    const priors = [
      { ts: Date.parse('2026-03-03T23:59:00+05:30'), amount: '90000.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' },
      { ts: Date.parse('2026-03-04T00:01:00+05:30'), amount: '50000.00', status: 'BLOCKED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' },
      { ts: Date.parse('2026-03-04T00:02:00+05:30'), amount: '1000.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' },
    ];
    assert.equal(run(tx(), card(), priors).f.approved_today, 1000);
  });
  test('R5 velocity_10m of 5 blocks with VELOCITY_BURST', () => {
    const priors = [...baseHistory(), ...[1, 2, 3, 4, 5].map((m) => ({ ts: T0 - m * MIN, amount: '100.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' }))];
    const r = run(tx({ channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' }), card(), priors);
    assert.equal(r.f.velocity_10m, 5);
    assert.deepEqual(r.reason_codes, ['VELOCITY_BURST']);
  });
  test('R6 impossible travel (worked example 5: Mumbai -> Delhi in 1 hour = 1148.09 km/h)', () => {
    const priors = [...baseHistory(), { ts: T0 - 60 * MIN, amount: '2400.00', status: 'APPROVED', merchant_id: 'M00450', channel: 'POS', txn_city: 'Mumbai' }];
    const r = run(tx({ amount: '4000.00', merchant_id: 'M00454', txn_city: 'Delhi' }), card(), priors);
    assert.equal(r.f.speed_kmph.toFixed(2), '1148.09');
    assert.deepEqual(r.reason_codes, ['IMPOSSIBLE_TRAVEL']);
    assert.equal(r.rule_risk_score, 100);
  });
  test('R6 not triggered for plausible travel (worked example 6: Pune, 120.15 km/h)', () => {
    const priors = [...baseHistory(), { ts: T0 - 60 * MIN, amount: '2400.00', status: 'APPROVED', merchant_id: 'M00450', channel: 'POS', txn_city: 'Mumbai' }];
    const r = run(tx({ amount: '3000.00', merchant_id: 'M00455', txn_city: 'Pune' }), card(), priors);
    assert.equal(r.f.speed_kmph.toFixed(2), '120.15');
    assert.equal(r.decision, 'APPROVE');
  });
  test('speed_kmph is empty for ECOM, for prior non-physical, and beyond the 6-hour look-back', () => {
    const p = (o) => [{ ts: T0 - 60 * MIN, amount: '2400.00', status: 'APPROVED', merchant_id: 'M00450', channel: 'POS', txn_city: 'Mumbai', ...o }];
    assert.equal(run(tx({ channel: 'ECOM', merchant_id: 'M00454', txn_city: 'Delhi' }), card(), p()).f.speed_kmph, null);
    assert.equal(run(tx({ merchant_id: 'M00454', txn_city: 'Delhi' }), card(), p({ channel: 'ECOM' })).f.speed_kmph, null);
    assert.equal(run(tx({ merchant_id: 'M00454', txn_city: 'Delhi' }), card(), p({ ts: T0 - 6 * 3600000 - 1000 })).f.speed_kmph, null);
    assert.equal(run(tx({ merchant_id: 'M00454', txn_city: 'Delhi' }), card(), p({ status: 'BLOCKED' })).f.speed_kmph, null);
  });
  test('several of R3-R6 list every triggered code, score 100, and skip R7-R13', () => {
    const priors = [...[1, 2, 3, 4, 5].map((m) => ({ ts: T0 - m * MIN, amount: '100.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' }))];
    const r = run(tx({ merchant_id: 'M00460', mcc: '6051', amount: '150000.00', txn_ts: undefined }), card(), priors);
    assert.deepEqual(r.reason_codes, ['MERCHANT_BLACKLISTED', 'DAILY_LIMIT_EXCEEDED', 'VELOCITY_BURST']);
    assert.equal(r.rule_risk_score, 100);
    assert.equal(r.rules.some((x) => x.rule === 'R10'), false);
  });
});

describe('soft rules R7-R12 and R13', () => {
  const recent = (n) => Array.from({ length: n }, (_, i) => ({ ts: T0 - (i + 1) * 2 * MIN, amount: '1200.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' }));
  test('R7 velocity_10m 3 and 4 step up with 25 points (worked example 9)', () => {
    for (const n of [3, 4]) {
      const r = run(tx({ amount: '1200.00', channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' }), card(), [...baseHistory(), ...recent(n)]);
      assert.equal(r.decision, 'STEP_UP');
      assert.deepEqual(r.reason_codes, ['HIGH_VELOCITY']);
      assert.equal(r.rule_risk_score, 25);
    }
    assert.equal(run(tx({ channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' }), card(), [...baseHistory(), ...recent(2)]).decision, 'APPROVE');
  });
  test('velocity window: exactly 10 minutes before counts, older and same-timestamp do not', () => {
    const at = (ms) => ({ ts: ms, amount: '10.00', status: 'BLOCKED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' });
    const f = run(tx(), card(), [at(T0 - 10 * MIN), at(T0 - 10 * MIN - 1000), at(T0), at(T0 - MIN)]).f;
    assert.equal(f.velocity_10m, 2);
  });
  test('R8 amount spike (worked examples 7 and 8): 15,000 steps up, 12,000 (= 5 x 2,400) does not', () => {
    const r = run(tx({ amount: '15000.00', channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' }));
    assert.deepEqual([r.decision, r.reason_codes, r.rule_risk_score], ['STEP_UP', ['AMOUNT_SPIKE'], 30]);
    assert.equal(run(tx({ amount: '12000.00', channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' })).decision, 'APPROVE');
    assert.equal(run(tx({ amount: '12000.01', channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' })).decision, 'STEP_UP');
  });
  test('R8 needs amount of 10,000 or more even when above 5 x average', () => {
    const small = [{ ts: T0 - 86400000, amount: '100.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' }];
    assert.equal(run(tx({ amount: '9999.99', channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' }), card(), small).decision, 'APPROVE');
    assert.equal(run(tx({ amount: '10000.00', channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' }), card(), small).decision, 'STEP_UP');
  });
  test('R8 without 30-day history: 50,000 or more steps up, below does not', () => {
    assert.deepEqual(run(tx({ amount: '50000.00' }), card(), []).reason_codes, ['AMOUNT_SPIKE']);
    assert.equal(run(tx({ amount: '49999.99' }), card(), []).decision, 'APPROVE');
    assert.equal(run(tx(), card(), []).f.avg_amount_30d, null);
  });
  test('avg_amount_30d ignores BLOCKED and pending transactions and those older than 30 days', () => {
    const p = [
      { ts: T0 - 86400000, amount: '1000.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' },
      { ts: T0 - 86400000, amount: '9000.00', status: 'BLOCKED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' },
      { ts: T0 - 86400000, amount: '9000.00', status: 'STEP_UP_PENDING', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' },
      { ts: T0 - 31 * 86400000, amount: '9000.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' },
    ];
    assert.equal(run(tx(), card(), p).f.avg_amount_30d, 1000);
  });
  test('R9 high-risk geography steps up with 25 points', () => {
    const r = run(tx({ merchant_id: 'M00461', mcc: '4829', channel: 'ECOM', txn_city: 'Port Axa', txn_country: 'XA', amount: '1000.00' }),
      card({ international_enabled: true }));
    assert.deepEqual(r.reason_codes, ['HIGH_RISK_GEO', 'HIGH_RISK_MCC']);
    assert.equal(r.rule_risk_score, 40);
  });
  test('R10 high-risk MCC steps up with 15 points', () => {
    const r = run(tx({ merchant_id: 'M00452', mcc: '6051', channel: 'ECOM', amount: '500.00' }), card(), [...baseHistory(),
      { ts: T0 - 86400000, amount: '400.00', status: 'APPROVED', merchant_id: 'M00452', channel: 'ECOM', txn_city: 'Mumbai' }]);
    assert.deepEqual([r.decision, r.reason_codes, r.rule_risk_score], ['STEP_UP', ['HIGH_RISK_MCC'], 15]);
  });
  test('R11 odd hour boundaries: 04:59 IST triggers, 05:00 does not; amount 20,000 minimum', () => {
    const ts = (hm) => Date.parse(`2026-03-04T${hm}:00+05:30`);
    const noSpike = [{ ts: ts('00:00') - 86400000, amount: '20000.00', status: 'APPROVED', merchant_id: 'M00450', channel: 'POS', txn_city: 'Mumbai' }];
    assert.deepEqual(run(tx({ ts: ts('04:59'), amount: '20000.00' }), card(), noSpike).reason_codes, ['ODD_HOUR_HIGH_VALUE']);
    assert.deepEqual(run(tx({ ts: ts('00:00'), amount: '20000.00' }), card(), noSpike).reason_codes, ['ODD_HOUR_HIGH_VALUE']);
    assert.equal(run(tx({ ts: ts('05:00'), amount: '20000.00' }), card(), noSpike).decision, 'APPROVE');
    assert.equal(run(tx({ ts: ts('03:00'), amount: '19999.99' }), card(), noSpike).decision, 'APPROVE');
  });
  test('R12 new merchant high value only for ECOM, 25,000 or more, merchant unseen for 90 days', () => {
    const big = [{ ts: T0 - 86400000, amount: '30000.00', status: 'APPROVED', merchant_id: 'M00450', channel: 'POS', txn_city: 'Mumbai' }];
    const ecom = (o) => tx({ channel: 'ECOM', merchant_id: 'M00451', mcc: '5732', amount: '25000.00', ...o });
    assert.deepEqual(run(ecom(), card(), big).reason_codes, ['NEW_MERCHANT_HIGH_VALUE']);
    assert.equal(run(ecom({ amount: '24999.99' }), card(), big).decision, 'APPROVE');
    assert.equal(run(ecom({ channel: 'POS' }), card(), big).decision, 'APPROVE');
    const seen = (days) => [...big, { ts: T0 - days * 86400000, amount: '100.00', status: 'BLOCKED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' }];
    assert.equal(run(ecom(), card(), seen(89)).decision, 'APPROVE', 'known merchant (any status) within 90 days');
    assert.equal(run(ecom(), card(), seen(91)).decision, 'STEP_UP');
  });
  test('R13 three soft rules block with MULTIPLE_RED_FLAGS listed last (worked example 10)', () => {
    const r = run(tx({ ts: Date.parse('2026-03-04T02:30:00+05:30'), amount: '45000.00', channel: 'ECOM', merchant_id: 'M00452', mcc: '6051' }));
    assert.equal(r.decision, 'BLOCK');
    assert.deepEqual(r.reason_codes, ['AMOUNT_SPIKE', 'HIGH_RISK_MCC', 'ODD_HOUR_HIGH_VALUE', 'NEW_MERCHANT_HIGH_VALUE', 'MULTIPLE_RED_FLAGS']);
    assert.equal(r.rule_risk_score, 80);
  });
  test('two soft rules step up (R13 needs three)', () => {
    const r = run(tx({ amount: '15000.00', channel: 'ECOM', merchant_id: 'M00452', mcc: '6051' }), card(), [...baseHistory(),
      { ts: T0 - 86400000, amount: '400.00', status: 'APPROVED', merchant_id: 'M00452', channel: 'ECOM', txn_city: 'Mumbai' }]);
    assert.deepEqual([r.decision, r.reason_codes, r.rule_risk_score], ['STEP_UP', ['AMOUNT_SPIKE', 'HIGH_RISK_MCC'], 45]);
  });
  test('rule_risk_score is capped at 100', () => {
    const at = Date.parse('2026-03-04T02:30:00+05:30');
    const burst = [1, 2, 3].map((m) => ({ ts: at - m * MIN, amount: '100.00', status: 'APPROVED', merchant_id: 'M00451', channel: 'ECOM', txn_city: 'Mumbai' }));
    const r = run(tx({ ts: at, merchant_id: 'M00461', mcc: '4829', channel: 'ECOM', txn_city: 'Port Axa',
      txn_country: 'XA', amount: '60000.00' }), card({ international_enabled: true, daily_limit: 1000000 }), [...baseHistory(), ...burst]);
    assert.equal(r.reason_codes.length, 7); // R7 R8 R9 R10 R11 R12 + R13
    assert.equal(r.rule_risk_score, 100);
  });
  test('configuration drives thresholds: velocity_burst_count 3 blocks at velocity 3', () => {
    const t = tx({ amount: '1200.00', channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' });
    const r = run(t, card(), [...baseHistory(), ...recent(3)], { ...cfg, velocity_burst_count: 3 });
    assert.deepEqual(r.reason_codes, ['VELOCITY_BURST']);
  });
  test('the official rules-config format maps onto every parameter (points by reason code, odd hours as whole hours)', () => {
    const { normaliseConfigJson } = require('../src/services/ruleConfig');
    const official = { velocity_window_minutes: 10, velocity_burst_count: 6, velocity_stepup_min: 2, velocity_stepup_max: 5, avg_lookback_days: 30,
      amount_spike_multiplier: 5, amount_spike_min_amount: 10000, amount_spike_no_history_amount: 50000, impossible_travel_kmph: 700,
      travel_lookback_hours: 6, earth_radius_km: 6371.0, odd_hour_start: 1, odd_hour_end: 3, odd_hour_min_amount: 20000,
      new_merchant_lookback_days: 90, new_merchant_min_amount: 25000, high_risk_mcc: ['4829'], multiple_red_flags_count: 3,
      points: { HIGH_VELOCITY: 11, AMOUNT_SPIKE: 12, HIGH_RISK_GEO: 13, HIGH_RISK_MCC: 14, ODD_HOUR_HIGH_VALUE: 15, NEW_MERCHANT_HIGH_VALUE: 16 },
      step_up_expiry_minutes: 15, false_positive_manager_limit: 90000, alert_high_amount: 40000, sla_minutes: { HIGH: 20, MEDIUM: 200 },
      ai_step_up_threshold: 0.6, ai_block_threshold: 0.8, model_timeout_ms: 120 };
    const { values, sources } = normaliseConfigJson(official);
    assert.deepEqual(values.points, { R7: 11, R8: 12, R9: 13, R10: 14, R11: 15, R12: 16 });
    assert.deepEqual([values.velocity_step_up_count, values.velocity_step_up_max, values.velocity_burst_count], [2, 5, 6]);
    assert.deepEqual([values.odd_hour_start, values.odd_hour_end], [1, 3]);
    assert.deepEqual([values.impossible_travel_speed_kmph, values.maker_checker_limit, values.alert_high_priority_amount], [700, 90000, 40000]);
    assert.deepEqual([values.sla_high_minutes, values.sla_medium_minutes, values.model_timeout_ms], [20, 200, 120]);
    assert.deepEqual(Object.keys(sources).filter((k) => sources[k] === 'default').sort(), ['ai_enabled', 'domestic_country', 'otp_max_attempts', 'rule_risk_score_cap']);
  });

  test('R7 upper bound comes from velocity_step_up_max', () => {
    const t = tx({ amount: '1200.00', channel: 'ECOM', merchant_id: 'M00451', mcc: '5732' });
    const r = run(t, card(), [...baseHistory(), ...recent(4)], { ...cfg, velocity_step_up_max: 3, velocity_burst_count: 6 });
    assert.equal(r.decision, 'APPROVE');
  });

  test('configuration drives lists and points: MCC list and R10 points', () => {
    const t = tx({ merchant_id: 'M00462', mcc: '5812', txn_city: 'Jaipur', amount: '500.00' });
    const r = run(t, card(), baseHistory(), { ...cfg, high_risk_mcc_list: ['5812'], points: { ...cfg.points, R10: 40 } });
    assert.deepEqual([r.reason_codes, r.rule_risk_score], [['HIGH_RISK_MCC'], 40]);
  });
});

describe('rules through the API (database-backed)', () => {
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

  test('changing velocity_burst_count in configuration changes the decision without a code change (FR-4)', async () => {
    const base = { card_id: 'C1009', txn_ts: '2026-03-04T14:05:00+05:30', amount: '1200.00', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM' };
    const r1 = await h.authorise(app.url, h.txn(base));
    assert.equal(r1.body.decision, 'STEP_UP');
    const token = await h.login(app.url, 'manager1');
    const put = await h.call(app.url, 'PUT', '/api/v1/config/velocity_burst_count', { token, body: { value: 3, comment: 'test change' } });
    assert.equal(put.status, 200);
    const r2 = await h.authorise(app.url, h.txn({ ...base, txn_ts: '2026-03-04T14:05:30+05:30' }));
    assert.deepEqual(r2.body.reason_codes, ['VELOCITY_BURST']);
    await h.call(app.url, 'PUT', '/api/v1/config/velocity_burst_count', { token, body: { value: 5 } });
  });

  test('concurrent transactions on the same card are serialised, so velocity counts stay correct', async () => {
    const t0 = Date.parse('2026-03-04T15:00:00+05:30');
    const { toIstIso } = require('../src/engine/time');
    const reqs = Array.from({ length: 8 }, (_, i) => h.txn({ card_id: 'C2011', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM', amount: '100.00', txn_ts: toIstIso(t0 + i * 1000) }));
    const res = await Promise.all(reqs.map((b) => h.authorise(app.url, b)));
    assert.ok(res.every((r) => r.status === 201));
    const { rows } = await h.db.query("SELECT txn_id, txn_ts, (features->>'velocity_10m')::int AS v FROM transactions WHERE card_id = 'C2011' ORDER BY processed_at, txn_id");
    rows.forEach((row, i) => {
      const expected = rows.slice(0, i).filter((p) => p.txn_ts < row.txn_ts).length;
      assert.equal(row.v, expected, `${row.txn_id} saw ${row.v} earlier transactions, expected ${expected}`);
    });
  });

  test('sequential same-card burst: 3 approve, 2 step up, the 6th blocks with VELOCITY_BURST', async () => {
    const { toIstIso } = require('../src/engine/time');
    const t0 = Date.parse('2026-03-04T16:00:00+05:30');
    const decisions = [];
    for (let i = 0; i < 6; i++) {
      const r = await h.authorise(app.url, h.txn({ card_id: 'C2012', merchant_id: 'M00451', mcc: '5732', channel: 'ECOM', amount: '100.00', txn_ts: toIstIso(t0 + i * 30000) }));
      decisions.push(r.body.decision + (r.body.reason_codes.length ? `:${r.body.reason_codes.join('|')}` : ''));
    }
    assert.deepEqual(decisions, ['APPROVE', 'APPROVE', 'APPROVE', 'STEP_UP:HIGH_VELOCITY', 'STEP_UP:HIGH_VELOCITY', 'BLOCK:VELOCITY_BURST']);
  });
});
