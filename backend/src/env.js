// Central place for environment-based settings. Defaults suit local development only.
const os = require('os');
const path = require('path');

const bool = (v, d) => (v === undefined ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

module.exports = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://fraudshield:fraudshield@localhost:5432/fraudshield',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  streamKey: process.env.EVENT_STREAM_KEY || 'fraudshield:events',
  mlUrl: process.env.ML_URL || 'http://localhost:5000',
  gatewayApiKey: process.env.GATEWAY_API_KEY || 'dev-gateway-key-change-me',
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
  jwtTtl: process.env.JWT_TTL || '12h',
  cardHashSalt: process.env.CARD_HASH_SALT || 'dev-card-salt-change-me',
  demoMode: bool(process.env.DEMO_MODE, true),
  demoPassword: process.env.DEMO_PASSWORD || 'Demo@123',
  enableTestRunner: bool(process.env.ENABLE_TEST_RUNNER, true),
  dataDir: process.env.DATA_DIR || '',
  repoRoot: path.resolve(__dirname, '..', '..'),
  outputDir: process.env.OUTPUT_DIR || path.resolve(__dirname, '..', '..', 'output'),
  instanceId: process.env.INSTANCE_ID || os.hostname(),
  stepUpSweepMs: Number(process.env.STEP_UP_SWEEP_MS || 5000),
  outboxPollMs: Number(process.env.OUTBOX_POLL_MS || 500),
  workers: bool(process.env.RUN_WORKERS, true),
  logLevel: process.env.LOG_LEVEL || 'info',
};
