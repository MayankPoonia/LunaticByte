// H. Batch command and worked examples.
//   1. Worked examples 1-10 replayed through the batch command on the test fixtures; every expected
//      value comes from the case-study document (section 6.4).
//   2. The installed data pack's sample batch (data/) processed against its own freshly
//      loaded history must reproduce every expected_* column and the expected alerts file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const { runBatch, verify } = require('../src/cli/batch');
const { seedAll } = require('../src/db/seed');
const { dataFile, resolveDataDir, readCsv } = require('../src/data/dataDir');

// txn_id, card, time, amount, merchant, channel, city, country, decision, codes, score, velocity, avg, speed
const EXAMPLES = [
  ['T200000001', 'C1001', '14:05', '3500.00', 'M00450', 'POS', 'Mumbai', 'IN', 'APPROVE', '', '0', '0', '2400.00', ''],
  ['T200000002', 'C1002', '14:05', '3500.00', 'M00450', 'POS', 'Mumbai', 'IN', 'BLOCK', 'CARD_NOT_ACTIVE', '', '', '', ''],
  ['T200000003', 'C1003', '14:05', '3500.00', 'M00453', 'POS', 'Singapore', 'SG', 'BLOCK', 'INTL_NOT_ENABLED', '', '', '', ''],
  ['T200000004', 'C1004', '14:05', '9500.00', 'M00450', 'POS', 'Mumbai', 'IN', 'BLOCK', 'DAILY_LIMIT_EXCEEDED', '100', '0', '6666.67', '0.00'],
  ['T200000005', 'C1005', '14:05', '4000.00', 'M00454', 'POS', 'Delhi', 'IN', 'BLOCK', 'IMPOSSIBLE_TRAVEL', '100', '0', '2400.00', '1148.09'],
  ['T200000006', 'C1006', '14:05', '3000.00', 'M00455', 'POS', 'Pune', 'IN', 'APPROVE', '', '0', '0', '2400.00', '120.15'],
  ['T200000007', 'C1007', '14:05', '15000.00', 'M00451', 'ECOM', 'Mumbai', 'IN', 'STEP_UP', 'AMOUNT_SPIKE', '30', '0', '2400.00', ''],
  ['T200000008', 'C1008', '14:05', '12000.00', 'M00451', 'ECOM', 'Mumbai', 'IN', 'APPROVE', '', '0', '0', '2400.00', ''],
  ['T200000009', 'C1009', '14:05', '1200.00', 'M00451', 'ECOM', 'Mumbai', 'IN', 'STEP_UP', 'HIGH_VELOCITY', '25', '3', '2243.48', ''],
  ['T200000010', 'C1010', '02:30', '45000.00', 'M00452', 'ECOM', 'Mumbai', 'IN', 'BLOCK',
    'AMOUNT_SPIKE|HIGH_RISK_MCC|ODD_HOUR_HIGH_VALUE|NEW_MERCHANT_HIGH_VALUE|MULTIPLE_RED_FLAGS', '80', '0', '2400.00', ''],
];
const EXPECTED_ALERTS = [['T200000005', 'HIGH', '2026-03-04T14:35:00+05:30'], ['T200000010', 'HIGH', '2026-03-04T03:00:00+05:30']];
const MCC = { M00450: '5411', M00451: '5732', M00452: '6051', M00453: '5311', M00454: '5411', M00455: '5411' };

test('worked examples 1-10 through the batch command match the case study exactly', async () => {
  await h.resetDb();
  const stub = await h.startStubModel();
  h.setMlUrl(stub.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-examples-'));
  const file = path.join(dir, 'sample.csv');
  const header = 'txn_id,card_id,txn_ts,amount,currency,merchant_id,mcc,channel,txn_city,txn_country,expected_decision,expected_reason_codes,'
    + 'expected_rule_risk_score,expected_velocity_10m,expected_avg_amount_30d,expected_speed_kmph';
  fs.writeFileSync(file, [header, ...EXAMPLES.map((e) => [e[0], e[1], `2026-03-04T${e[2]}:00+05:30`, e[3], 'INR', e[4], MCC[e[4]], e[5], e[6], e[7], ...e.slice(8)].join(','))].join('\n'));
  const alertsFile = path.join(dir, 'expected_alerts.csv');
  fs.writeFileSync(alertsFile, ['txn_id,alert_priority,sla_due_at', ...EXPECTED_ALERTS.map((a) => a.join(','))].join('\n'));
  const r = await runBatch({ file, outDir: dir, reset: false, log: () => {} });
  const mismatches = verify(r.results, alertsFile, dir);
  await stub.close();
  assert.deepEqual(mismatches, []);
  const decisions = fs.readFileSync(path.join(dir, 'decisions_output.csv'), 'utf8').trim().split('\n');
  assert.equal(decisions[0], 'txn_id,decision,reason_codes,rule_risk_score,velocity_10m,avg_amount_30d,speed_kmph');
  assert.equal(decisions.find((l) => l.startsWith('T200000002')), 'T200000002,BLOCK,CARD_NOT_ACTIVE,,,,');
  // rows are processed in txn_ts order: example 10 (02:30) comes first
  assert.ok(decisions[1].startsWith('T200000010'));
  const scores = fs.readFileSync(path.join(dir, 'fraud_scores_output.csv'), 'utf8').trim().split('\n');
  assert.equal(scores[0], 'txn_id,fraud_score,final_decision,top_factors');
  assert.match(scores[1], /^T\d{9},\d\.\d{4},(APPROVE|STEP_UP|BLOCK),/);
});

test("the installed data pack's sample batch reproduces all expected columns and alerts", async (t) => {
  const { dir } = resolveDataDir();
  const file = dataFile('batch_transactions_sample', dir);
  if (!file) {
    t.skip('no case_01_batch_transactions_sample file in the data pack');
    return;
  }
  const stub = await h.startStubModel();
  h.setMlUrl(stub.url);
  await seedAll({ reset: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-sample-'));
  const r = await runBatch({ file, outDir: out, reset: false, log: () => {} });
  const mismatches = verify(r.results, dataFile('batch_sample_expected_alerts', dir), out);
  await stub.close();
  t.diagnostic(`${readCsv(file).length} rows from ${path.relative(h.ROOT, file)}, ${r.processing_ms} ms`);
  assert.equal(r.rejected, 0);
  assert.deepEqual(mismatches.slice(0, 20), []);
});
