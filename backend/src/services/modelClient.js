// HTTP client for the Flask XGBoost service. Any error, non-200 response or a call slower than
// model_timeout_ms (150 ms by default) is treated as MODEL_UNAVAILABLE and the rules-only decision stands.
const env = require('../env');
const log = require('../logger');

let mlUrl = env.mlUrl;

function setMlUrl(url) {
  mlUrl = url;
}

function getMlUrl() {
  return mlUrl;
}

async function scoreTransaction(features, { timeoutMs = 150, enabled = true } = {}) {
  if (!enabled) return { model_status: 'DISABLED', fraud_score: null, top_factors: [], model_version: null, latency_ms: null };
  const started = performance.now();
  try {
    const res = await fetch(`${mlUrl}/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `model service HTTP ${res.status}`);
    const latency = performance.now() - started;
    if (typeof body.fraud_score !== 'number' || body.fraud_score < 0 || body.fraud_score > 1) throw new Error('invalid fraud_score');
    return {
      model_status: 'OK',
      fraud_score: body.fraud_score,
      top_factors: body.top_factors || [],
      model_version: body.model_version,
      latency_ms: Math.round(latency * 100) / 100,
    };
  } catch (err) {
    const latency = performance.now() - started;
    log.warn('model unavailable, using rules-only decision', { reason: err.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : err.message });
    return { model_status: 'MODEL_UNAVAILABLE', fraud_score: null, top_factors: [], model_version: null, latency_ms: Math.round(latency * 100) / 100 };
  }
}

async function modelInfo() {
  const res = await fetch(`${mlUrl}/model/info`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`model service HTTP ${res.status}`);
  return res.json();
}

async function modelHealth() {
  try {
    const res = await fetch(`${mlUrl}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : { status: 'DOWN' };
  } catch {
    return { status: 'DOWN' };
  }
}

module.exports = { scoreTransaction, modelInfo, modelHealth, setMlUrl, getMlUrl };
