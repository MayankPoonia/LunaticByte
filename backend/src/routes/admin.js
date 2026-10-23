// Manager tools: rule configuration, model information, demo reset, test runner, system status.
const express = require('express');
const env = require('../env');
const { query, withTx } = require('../db');
const { requireUser, requireRole, STAFF } = require('../middleware/auth');
const { PARAMS, DEFAULTS, validateValue } = require('../services/ruleConfig');
const { audit } = require('../services/audit');
const { modelInfo, modelHealth, getMlUrl } = require('../services/modelClient');
const { seedAll } = require('../db/seed');
const { loadRefs } = require('../data/refs');
const { resolveDataDir } = require('../data/dataDir');
const stepUps = require('../services/stepUps');
const { runCategory, CATEGORIES } = require('../cli/testCategories');
const { HttpError } = require('../errors');

const staff = [requireUser, requireRole(...STAFF)];
const manager = [requireUser, requireRole('MANAGER')];

function createAdminRouter({ consumerStats = () => null } = {}) {
  const router = express.Router();

  // ---------------------------------------------------------------- rule configuration
  router.get('/config', staff, async (req, res) => {
    const { rows } = await query('SELECT key, value, source, description, updated_by, updated_at FROM rule_config');
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const params = PARAMS.map(([key]) => byKey[key] || { key, value: DEFAULTS[key], source: 'default' });
    const versions = await query('SELECT version, changed_by, changed_at FROM config_versions ORDER BY version DESC LIMIT 20');
    res.json({ params, versions: versions.rows, version: versions.rows[0] ? versions.rows[0].version : 0 });
  });

  router.put('/config/:key', manager, async (req, res) => {
    const { key } = req.params;
    const value = req.body ? req.body.value : undefined;
    const problem = validateValue(key, value);
    if (problem) throw new HttpError(422, 'VALIDATION_ERROR', problem, [{ field: 'value', message: problem }]);
    const result = await withTx(async (client) => {
      const before = await client.query('SELECT value FROM rule_config WHERE key = $1 FOR UPDATE', [key]);
      const old = before.rows.length ? before.rows[0].value : DEFAULTS[key];
      await client.query(
        `INSERT INTO rule_config (key, value, source, description, updated_by, updated_at) VALUES ($1, $2, 'user', $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, source = 'user', updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), PARAMS.find((p) => p[0] === key)[2], req.user.user_id]);
      const all = await client.query('SELECT key, value FROM rule_config');
      const snapshot = Object.fromEntries(all.rows.map((r) => [r.key, r.value]));
      const v = await client.query('INSERT INTO config_versions (changed_by, snapshot) VALUES ($1, $2) RETURNING version', [req.user.user_id, JSON.stringify({ values: snapshot })]);
      await audit(client, { entity: 'CONFIG', entityId: key, actor: req.user.user_id, role: req.user.role, action: 'CONFIG_CHANGED',
        comment: req.body.comment || null, details: { before: old, after: value, version: v.rows[0].version } });
      return { key, before: old, after: value, version: v.rows[0].version };
    });
    res.json(result);
  });

  // ---------------------------------------------------------------- model
  router.get('/model/info', staff, async (req, res) => {
    try {
      res.json(await modelInfo());
    } catch (err) {
      res.status(503).json({ error: 'MODEL_UNAVAILABLE', message: err.message });
    }
  });

  router.post('/model/score', staff, async (req, res) => {
    const r = await fetch(`${getMlUrl()}/predict`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ features: (req.body || {}).features }),
      signal: AbortSignal.timeout(2000),
    }).catch((err) => ({ ok: false, status: 503, json: async () => ({ error: 'MODEL_UNAVAILABLE', message: err.message }) }));
    res.status(r.ok ? 200 : r.status).json(await r.json());
  });

  // ---------------------------------------------------------------- demo utilities (DEMO_MODE only)
  const demoOnly = (req, res, next) => (env.demoMode ? next() : res.status(404).json({ error: 'NOT_FOUND' }));

  router.post('/demo/reset', manager, demoOnly, async (req, res) => {
    if ((req.body || {}).confirm !== 'RESET') throw new HttpError(422, 'VALIDATION_ERROR', 'Send {"confirm":"RESET"} to reset demo data');
    const summary = await seedAll({ reset: true });
    await loadRefs();
    res.json(summary);
  });

  // Makes a pending step-up due now and runs the regular expiry job (demonstrates STEP_UP_TIMEOUT).
  router.post('/demo/step-ups/:id/expire', manager, demoOnly, async (req, res) => {
    const { rowCount } = await query("UPDATE step_ups SET expires_at = now() WHERE step_up_id = $1 AND status = 'PENDING'", [req.params.id]);
    if (!rowCount) throw new HttpError(409, 'STEP_UP_NOT_PENDING', 'Step-up is not pending');
    res.json({ expired: await stepUps.expireDue() });
  });

  // ---------------------------------------------------------------- test runner
  router.get('/test-runner/categories', manager, (req, res) => res.json({ enabled: env.enableTestRunner, categories: CATEGORIES }));

  let running = false;
  router.post('/test-runner/run', manager, async (req, res) => {
    if (!env.enableTestRunner) throw new HttpError(404, 'NOT_FOUND', 'Test runner disabled');
    if (running) throw new HttpError(409, 'TEST_RUN_IN_PROGRESS', 'Another test run is in progress');
    running = true;
    try {
      res.json(await runCategory((req.body || {}).category));
    } finally {
      running = false;
    }
  });

  // ---------------------------------------------------------------- system status
  router.get('/system/status', staff, async (req, res) => {
    const outbox = await query('SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS pending, max(attempts)::int AS max_attempts FROM outbox_events');
    let data;
    try {
      data = resolveDataDir();
    } catch (err) {
      data = { error: err.message };
    }
    res.json({ instance: env.instanceId, data, model: await modelHealth(), outbox: outbox.rows[0], events: consumerStats() });
  });

  return router;
}

module.exports = { createAdminRouter };
