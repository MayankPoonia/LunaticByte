// Test categories used by the CLI (npm run test:category -- B) and the Test Runner page.
// Each category is one node:test file; results are collected with a small JSON reporter.
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const CATEGORIES = [
  { id: 'A', name: 'API and security', file: 'tests/A_api_security.test.js' },
  { id: 'B', name: 'Rules engine', file: 'tests/B_rules.test.js' },
  { id: 'C', name: 'XGBoost model', file: 'tests/C_model.test.js' },
  { id: 'D', name: 'Transaction lifecycle', file: 'tests/D_lifecycle.test.js' },
  { id: 'E', name: 'Alerts and concurrency', file: 'tests/E_alerts.test.js' },
  { id: 'F', name: 'Events and recovery', file: 'tests/F_events.test.js' },
  { id: 'G', name: 'Performance', file: 'tests/G_performance.test.js' },
  { id: 'H', name: 'Batch and worked examples', file: 'tests/H_batch.test.js' },
];

// Test runs share one test database, so only one may run at a time across all backend replicas.
async function withRunLock(fn) {
  const { Client } = require('pg');
  const env = require('../env');
  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(724002) AS ok');
    if (!rows[0].ok) throw Object.assign(new Error('another test run is in progress'), { status: 409 });
    return await fn();
  } finally {
    await client.end();
  }
}

async function runCategory(id) {
  const cat = CATEGORIES.find((c) => c.id === String(id || '').toUpperCase());
  if (!cat) throw Object.assign(new Error(`unknown category ${id}`), { status: 422 });
  return withRunLock(() => spawnCategory(cat));
}

function spawnCategory(cat) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=./tests/reporter.mjs', cat.file], {
      cwd: ROOT, env: { ...process.env, NODE_ENV: 'test' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const tests = out.split('\n').filter((l) => l.startsWith('{')).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
      resolve({
        category: cat, exit_code: code, duration_ms: Date.now() - started,
        passed: tests.filter((t) => t.status === 'pass').length,
        failed: tests.filter((t) => t.status === 'fail').length,
        skipped: tests.filter((t) => t.status === 'skip').length,
        tests, stderr: err.slice(-4000),
      });
    });
  });
}

module.exports = { CATEGORIES, runCategory, ROOT };
