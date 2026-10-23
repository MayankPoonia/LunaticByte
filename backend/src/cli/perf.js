// Reproducible performance test against a running deployment (through Nginx by default).
// Sends N authorisations with C concurrent clients spread over many cards (so velocity rules do not
// dominate), first with the model and then rules-only (ai_enabled switched off and back on via the
// manager API), and prints latency percentiles against the SLA.
//   node src/cli/perf.js [--url http://localhost:8080] [--requests 300] [--concurrency 10]
const env = require('../env');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const url = arg('--url', process.env.API_URL || 'http://localhost:8080');
const total = Number(arg('--requests', 300));
const concurrency = Number(arg('--concurrency', 10));
const key = arg('--key', env.gatewayApiKey);

async function json(method, path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), servedBy: res.headers.get('x-served-by') };
}

async function run(label, cards, merchant, idBase) {
  let next = 0;
  let clock = Date.now() - 365 * 86400000; // a quiet day in the past so velocity windows stay empty
  const lat = [];
  const servers = {};
  const status = {};
  const models = {};
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) {
      const i = next++;
      clock += 61000;
      const ts = new Date(clock + 330 * 60000).toISOString().slice(0, 19) + '+05:30';
      const body = { txn_id: `T${idBase + i}`, card_id: cards[i % cards.length], txn_ts: ts, amount: '250.00', currency: 'INR',
        merchant_id: merchant.merchant_id, mcc: merchant.mcc, channel: 'ECOM', txn_city: merchant.city, txn_country: merchant.country };
      const started = performance.now();
      const r = await fetch(`${url}/api/v1/authorisations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      lat.push(performance.now() - started);
      status[r.status] = (status[r.status] || 0) + 1;
      models[data.model_status] = (models[data.model_status] || 0) + 1;
      const s = r.headers.get('x-served-by');
      servers[s] = (servers[s] || 0) + 1;
    }
  }));
  const s = [...lat].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  console.log(`${label}: ${total} requests, ${concurrency} clients | p50 ${p(0.5).toFixed(1)} ms | p95 ${p(0.95).toFixed(1)} ms | p99 ${p(0.99).toFixed(1)} ms | max ${s[s.length - 1].toFixed(1)} ms`);
  console.log(`  HTTP ${JSON.stringify(status)} | model_status ${JSON.stringify(models)} | served by ${JSON.stringify(servers)}`);
  return p(0.95);
}

(async () => {
  const login = await json('POST', '/api/v1/auth/login', { username: 'manager1', password: env.demoPassword });
  if (login.status !== 200) throw new Error('manager1 login failed (DEMO_MODE seeded accounts are required)');
  const token = login.body.token;
  const opts = await json('GET', '/api/v1/simulator/options', null, token);
  const cards = opts.body.cards.filter((c) => c.card_status === 'ACTIVE' && Number(c.daily_limit) >= 50000).map((c) => c.card_id).slice(10);
  const merchant = opts.body.merchants.find((m) => m.merchant_risk === 'LOW' && m.country === 'IN' && !['4829', '5967', '6051', '7995'].includes(m.mcc));
  const base = 500000000 + (Date.now() % 100000) * 1000;
  console.log(`target ${url}; ${cards.length} cards; merchant ${merchant.merchant_id}\n`);
  const full = await run('With model', cards, merchant, base);
  await json('PUT', '/api/v1/config/ai_enabled', { value: false, comment: 'perf test rules-only run' }, token);
  let rules;
  try {
    rules = await run('Rules only', cards, merchant, base + total);
  } finally {
    await json('PUT', '/api/v1/config/ai_enabled', { value: true, comment: 'perf test finished' }, token);
  }
  console.log(`\nSLA check: with model p95 ${full.toFixed(1)} ms ${full < 300 ? '<' : '>='} 300 ms; rules-only p95 ${rules.toFixed(1)} ms ${rules < 150 ? '<' : '>='} 150 ms`);
  console.log('Note: these transactions are real decisions; reset the demo data afterwards if you need a clean dashboard.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
