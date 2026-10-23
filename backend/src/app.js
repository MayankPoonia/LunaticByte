// Express application (no listening, no workers) so tests can mount it in-process.
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const env = require('./env');
const log = require('./logger');
const { query } = require('./db');
const { ValidationError } = require('./validation');
const { HttpError } = require('./errors');
const { modelHealth } = require('./services/modelClient');
const openapi = require('./openapi');

function createApp({ redis = null, consumerStats } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  // Shows which replica served the request (useful to see Nginx load balancing).
  app.use((req, res, next) => {
    res.set('X-Served-By', env.instanceId);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', instance: env.instanceId }));
  app.get('/ready', async (req, res) => {
    const checks = { database: 'down', redis: redis && redis.status === 'ready' ? 'up' : 'down', model: 'down' };
    try {
      await query('SELECT 1');
      checks.database = 'up';
    } catch { /* reported below */ }
    checks.model = (await modelHealth()).status === 'UP' ? 'up' : 'down';
    // Only the database is required: Redis and the model have documented fallbacks.
    res.status(checks.database === 'up' ? 200 : 503).json({ status: checks.database === 'up' ? 'ready' : 'not_ready', checks, instance: env.instanceId });
  });

  app.get('/api/openapi.json', (req, res) => res.json(openapi));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'FraudShield API' }));

  const api = express.Router();
  api.use(require('./routes/authorisations'));
  api.use(require('./routes/auth'));
  api.use(require('./routes/simulator'));
  api.use(require('./routes/me'));
  api.use(require('./routes/staff'));
  api.use(require('./routes/admin').createAdminRouter({ consumerStats }));
  app.use('/api/v1', api);

  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(err.status).json({ error: 'VALIDATION_ERROR', message: 'Invalid request', fields: err.fields });
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), ...(err.code === 'VALIDATION_ERROR' && Array.isArray(err.details) ? { fields: err.details } : {}) });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON', message: 'Request body is not valid JSON' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: 'BAD_REQUEST', message: err.message });
    log.error('unhandled error', { path: req.path, error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  return app;
}

module.exports = { createApp };
