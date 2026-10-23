// Batch command (FR-10). Processes a transaction file in txn_ts order (ties by txn_id) against a
// freshly loaded history and writes:
//   output/decisions_output.csv     rules-only decisions
//   output/alerts_output.csv        alerts created by the batch (rules-only)
//   output/fraud_scores_output.csv  model score and final decision after AI-2
//
//   node src/cli/batch.js --file sample|eval|<path> [--out <dir>] [--no-reset] [--verify]
// --verify compares with the expected_* columns and the expected alerts file when they exist.
const fs = require('fs');
const path = require('path');
const env = require('../env');
const { query, getPool } = require('../db');
const { seedAll } = require('../db/seed');
const { loadRefs } = require('../data/refs');
const { readCsv, dataFile } = require('../data/dataDir');
const { validateTransaction } = require('../validation');
const { authorise } = require('../services/authorise');
const { toIstIso } = require('../engine/time');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function resolveFile(f) {
  if (f === 'sample') return dataFile('batch_transactions_sample');
  if (f === 'eval') return dataFile('batch_transactions_eval');
  return path.resolve(f);
}

const csvLine = (values) => values.map((v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',');

async function runBatch({ file, outDir = env.outputDir, reset = true, log = console.log }) {
  const started = Date.now();
  if (reset) await seedAll({ reset: true });
  await loadRefs();
  const rows = readCsv(file).map((r) => ({ ...r, ts: Date.parse(r.txn_ts) }))
    .sort((a, b) => a.ts - b.ts || a.txn_id.localeCompare(b.txn_id));

  const results = [];
  for (const r of rows) {
    const body = { txn_id: r.txn_id, card_id: r.card_id, txn_ts: r.txn_ts, amount: r.amount, currency: r.currency || 'INR',
      merchant_id: r.merchant_id, mcc: r.mcc, channel: r.channel, txn_city: r.txn_city, txn_country: r.txn_country };
    try {
      const txn = validateTransaction(body);
      const { response } = await authorise(txn, { source: 'BATCH', mode: 'batch', actor: { id: 'batch', role: 'SYSTEM' } });
      results.push({ row: r, response });
    } catch (err) {
      log(`row ${r.txn_id} rejected: ${err.fields ? JSON.stringify(err.fields) : err.message}`);
      results.push({ row: r, error: err });
    }
  }
  const processingMs = Date.now() - started;

  const ok = results.filter((x) => x.response);
  const ids = ok.map((x) => x.row.txn_id);
  const stored = new Map((await query('SELECT txn_id, ai_decision, rules_decision, fraud_score, top_factors FROM transactions WHERE txn_id = ANY($1)', [ids]))
    .rows.map((t) => [t.txn_id, t]));
  const alertRows = (await query('SELECT txn_id, priority, sla_due_at FROM alerts WHERE txn_id = ANY($1)', [ids])).rows;
  const alertByTxn = new Map(alertRows.map((a) => [a.txn_id, a]));

  fs.mkdirSync(outDir, { recursive: true });
  const decisions = ['txn_id,decision,reason_codes,rule_risk_score,velocity_10m,avg_amount_30d,speed_kmph'];
  const alerts = ['txn_id,alert_priority,sla_due_at'];
  const scores = ['txn_id,fraud_score,final_decision,top_factors'];
  for (const { row, response: res } of ok) {
    const hard = res.rule_risk_score === null; // R1/R2 hard stop: derived fields are left empty
    const f = res.features;
    decisions.push(csvLine([row.txn_id, res.rules_decision, res.reason_codes.join('|'), hard ? '' : res.rule_risk_score,
      hard ? '' : f.velocity_10m, hard || f.avg_amount_30d === null ? '' : f.avg_amount_30d.toFixed(2),
      hard || f.speed_kmph === null ? '' : f.speed_kmph.toFixed(2)]));
    const a = alertByTxn.get(row.txn_id);
    if (a) alerts.push(csvLine([row.txn_id, a.priority, toIstIso(new Date(a.sla_due_at).getTime())]));
    const s = stored.get(row.txn_id);
    scores.push(csvLine([row.txn_id, s.fraud_score === null ? '' : Number(s.fraud_score).toFixed(4), s.ai_decision || s.rules_decision,
      (s.top_factors || []).map((t) => t.feature).join('|')]));
  }
  fs.writeFileSync(path.join(outDir, 'decisions_output.csv'), decisions.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'alerts_output.csv'), alerts.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'fraud_scores_output.csv'), scores.join('\n') + '\n');
  const modelDown = ok.filter((x) => x.response.model_status !== 'OK').length;
  return { rows: rows.length, processed: ok.length, rejected: results.length - ok.length, alerts: alerts.length - 1, model_unavailable: modelDown,
    processing_ms: processingMs, outDir, results };
}

// Compare with expected_* columns and the expected alerts file. Returns a list of mismatches.
function verify(results, expectedAlertsFile, outDir) {
  const mismatches = [];
  const fmt2 = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2));
  for (const { row, response: res } of results.filter((x) => x.response)) {
    if (row.expected_decision === undefined) continue;
    const hard = res.rule_risk_score === null;
    const got = {
      decision: res.rules_decision, reason_codes: res.reason_codes.join('|'), rule_risk_score: hard ? '' : String(res.rule_risk_score),
      velocity_10m: hard ? '' : String(res.features.velocity_10m), avg_amount_30d: hard ? '' : fmt2(res.features.avg_amount_30d),
      speed_kmph: hard ? '' : fmt2(res.features.speed_kmph),
    };
    for (const k of Object.keys(got)) {
      const exp = (row[`expected_${k}`] || '').trim();
      const norm = ['avg_amount_30d', 'speed_kmph'].includes(k) && exp !== '' ? Number(exp).toFixed(2) : exp;
      if (norm !== got[k]) mismatches.push({ txn_id: row.txn_id, field: k, expected: exp, got: got[k] });
    }
  }
  if (expectedAlertsFile) {
    const expected = readCsv(expectedAlertsFile);
    const produced = readCsv(path.join(outDir, 'alerts_output.csv'));
    const key = (a) => `${a.txn_id}|${a.alert_priority}|${Date.parse(a.sla_due_at)}`;
    const p = new Set(produced.map(key));
    const e = new Set(expected.map(key));
    for (const a of expected) if (!p.has(key(a))) mismatches.push({ txn_id: a.txn_id, field: 'alert', expected: `${a.alert_priority} ${a.sla_due_at}`, got: 'missing or different' });
    for (const a of produced) if (!e.has(key(a))) mismatches.push({ txn_id: a.txn_id, field: 'alert', expected: 'no alert', got: `${a.alert_priority} ${a.sla_due_at}` });
  }
  return mismatches;
}

if (require.main === module) {
  (async () => {
    const file = resolveFile(arg('--file', 'sample'));
    if (!file || !fs.existsSync(file)) throw new Error(`batch file not found: ${arg('--file', 'sample')}`);
    const out = path.resolve(arg('--out', env.outputDir));
    const r = await runBatch({ file, outDir: out, reset: !process.argv.includes('--no-reset') });
    console.log(`processed ${r.processed}/${r.rows} rows from ${path.basename(file)} in ${r.processing_ms} ms; ${r.alerts} alerts; `
      + `model unavailable for ${r.model_unavailable}; outputs in ${r.outDir}`);
    if (process.argv.includes('--verify')) {
      const expectedAlerts = arg('--file', 'sample') === 'sample' ? dataFile('batch_sample_expected_alerts') : null;
      const mismatches = verify(r.results, expectedAlerts, out);
      if (mismatches.length) {
        console.log(`${mismatches.length} mismatch(es):`);
        for (const m of mismatches) console.log(`  ${m.txn_id} ${m.field}: expected "${m.expected}", got "${m.got}"`);
        process.exitCode = 1;
      } else console.log('verification passed: all expected columns and alerts match');
    }
    await getPool().end();
  })().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { runBatch, verify, resolveFile };
