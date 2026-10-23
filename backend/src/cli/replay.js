// Replay mode (FR-10 SHOULD): acts as the simulated card gateway and posts a transaction file to the
// authorisation API at a configurable rate, printing each decision and the latency summary.
//   node src/cli/replay.js --file sample|eval|<path> [--rate 5] [--url http://localhost:8080] [--key <gateway key>]
const fs = require('fs');
const env = require('../env');
const { readCsv } = require('../data/dataDir');
const { resolveFile } = require('./batch');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const FIELDS = ['txn_id', 'card_id', 'txn_ts', 'amount', 'currency', 'merchant_id', 'mcc', 'channel', 'txn_city', 'txn_country'];

(async () => {
  const file = resolveFile(arg('--file', 'sample'));
  if (!file || !fs.existsSync(file)) throw new Error('batch file not found');
  const url = arg('--url', process.env.API_URL || 'http://localhost:8080');
  const key = arg('--key', env.gatewayApiKey);
  const rate = Number(arg('--rate', 5));
  const rows = readCsv(file).sort((a, b) => Date.parse(a.txn_ts) - Date.parse(b.txn_ts) || a.txn_id.localeCompare(b.txn_id));
  const latencies = [];
  const counts = {};
  for (const r of rows) {
    const started = performance.now();
    const body = Object.fromEntries(FIELDS.map((f) => [f, r[f]]));
    if (!body.currency) body.currency = 'INR';
    const res = await fetch(`${url}/api/v1/authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
    const ms = performance.now() - started;
    const data = await res.json().catch(() => ({}));
    latencies.push(ms);
    const label = res.ok ? data.decision : `HTTP ${res.status}`;
    counts[label] = (counts[label] || 0) + 1;
    console.log(`${r.txn_id} ${String(label).padEnd(8)} ${(data.reason_codes || []).join('|') || '-'}  score ${data.fraud_score ?? '-'}  ${ms.toFixed(0)} ms`);
    const wait = 1000 / rate - ms;
    if (wait > 0) await new Promise((res2) => setTimeout(res2, wait));
  }
  const s = [...latencies].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  console.log(`\n${rows.length} transactions: ${JSON.stringify(counts)}; latency p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${s[s.length - 1].toFixed(1)} ms`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
