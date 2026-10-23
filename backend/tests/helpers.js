// Test harness. Every test file runs against its own fresh copy of a separate database
// (<main db>_test) loaded with deterministic fixtures, so tests never depend on demo state or on
// which data pack is installed. The model is a stub by default (programmable scores); category C
// also talks to the real Flask service when it is reachable.
const path = require('path');
const http = require('http');

const mainUrl = process.env.DATABASE_URL || 'postgres://fraudshield:fraudshield@localhost:5432/fraudshield';
const testUrl = process.env.TEST_DATABASE_URL || mainUrl.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');
process.env.DATABASE_URL = testUrl;
process.env.EVENT_STREAM_KEY = `fraudshield:test:${process.pid}`;
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'error';
process.env.INSTANCE_ID = `test-${process.pid}`;
const REAL_ML_URL = process.env.ML_URL || 'http://localhost:5000';

const { Client } = require('pg');
const { after: afterAll } = require('node:test');
const env = require('../src/env');
const db = require('../src/db');
const { migrate, bulkInsert, hashCard } = require('../src/db/seed');
const { loadRefs } = require('../src/data/refs');
const { normaliseConfigJson, DESCRIPTIONS } = require('../src/services/ruleConfig');
const { setMlUrl } = require('../src/services/modelClient');
const { createApp } = require('../src/app');
const { createSocketServer } = require('../src/events/socket');
const { createPublisher } = require('../src/events/publisher');
const { createConsumer } = require('../src/events/consumer');
const { createRedis } = require('../src/redis');
const fx = require('./fixtures');

// Close the pool when the file finishes so the process exits immediately.
afterAll(() => db.getPool().end());

async function ensureDatabase() {
  const u = new URL(testUrl);
  const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  const admin = new Client({ connectionString: u.toString() });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!rows.length) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
}

async function resetDb() {
  await ensureDatabase();
  await db.withTx(async (c) => {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await migrate(c);
    await fx.load(c, { bulkInsert, hashCard, normaliseConfigJson, DESCRIPTIONS });
  });
  await loadRefs();
}

// ---------------------------------------------------------------- stub model service
function startStubModel() {
  const state = { score: () => 0.01, delayMs: 0, calls: 0, fail: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/health') return res.end(JSON.stringify({ status: 'UP', model_loaded: true, model_version: 'stub' }));
      state.calls += 1;
      const features = (JSON.parse(body || '{}').features) || {};
      setTimeout(() => {
        if (state.fail) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: 'stub failure' }));
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ fraud_score: state.score(features), model_version: 'stub-1', model_status: 'OK',
          top_factors: [{ feature: 'amount', text: 'stub factor', contribution: 0.1, direction: 'raises' }] }));
      }, state.delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise((r) => server.close(r));
    state.reset = () => Object.assign(state, { score: () => 0.01, delayMs: 0, fail: false });
    resolve(state);
  }));
}

// ---------------------------------------------------------------- in-process application
async function startApp({ redisUrl = env.redisUrl, workers = true } = {}) {
  const redis = createRedis('test-publisher', redisUrl);
  const reader = createRedis('test-consumer', redisUrl);
  const consumerRef = { c: null };
  const app = createApp({ redis, consumerStats: () => consumerRef.c && consumerRef.c.stats() });
  const server = http.createServer(app);
  const { io, deliver } = createSocketServer(server);
  const publisher = createPublisher(redis, { pollMs: 200 });
  if (workers) {
    publisher.start();
    consumerRef.c = createConsumer(reader, deliver);
    await consumerRef.c.start();
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, redis, publisher, consumer: consumerRef.c, io,
    async close() {
      publisher.stop();
      if (consumerRef.c) consumerRef.c.stop();
      io.close();
      await new Promise((r) => server.close(r));
      redis.disconnect();
      reader.disconnect();
    },
  };
}

async function call(base, method, urlPath, { token, apiKey, body, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  const started = performance.now();
  const res = await fetch(base + urlPath, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* csv or empty */ }
  return { status: res.status, body: json, text, headers: res.headers, ms: performance.now() - started };
}

async function login(base, username) {
  const r = await call(base, 'POST', '/api/v1/auth/login', { body: { username, password: env.demoPassword } });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status}`);
  return r.body.token;
}

let seq = 800000000;
function txn(overrides = {}) {
  seq += 1;
  return { txn_id: `T${seq}`, card_id: 'C1001', txn_ts: '2026-03-04T14:05:00+05:30', amount: '3500.00', currency: 'INR', merchant_id: 'M00450',
    mcc: '5411', channel: 'POS', txn_city: 'Mumbai', txn_country: 'IN', ...overrides };
}

const authorise = (base, body) => call(base, 'POST', '/api/v1/authorisations', { apiKey: env.gatewayApiKey, body });

async function setConfig(key, value) {
  await db.query(`UPDATE rule_config SET value = $2 WHERE key = $1`, [key, JSON.stringify(value)]);
}

function waitFor(predicate, timeoutMs = 5000, stepMs = 50) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const v = await predicate();
        if (v) return resolve(v);
      } catch { /* retry */ }
      if (Date.now() - started > timeoutMs) return reject(new Error(`condition not met within ${timeoutMs} ms`));
      return setTimeout(tick, stepMs);
    };
    tick();
  });
}

async function mlReachable() {
  try {
    const r = await fetch(`${REAL_ML_URL}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

module.exports = {
  resetDb, startApp, startStubModel, call, login, txn, authorise, setConfig, waitFor, mlReachable, setMlUrl, db, env, fx, REAL_ML_URL,
  ROOT: path.resolve(__dirname, '..'),
};
