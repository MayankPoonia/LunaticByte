// Process entry point: migrate + seed (first start only), load reference data, then start the HTTP
// server, Socket.IO, the outbox publisher, the stream consumer and the step-up expiry job.
const http = require('http');
const env = require('./env');
const log = require('./logger');
const { seedAll } = require('./db/seed');
const { loadRefs } = require('./data/refs');
const { createApp } = require('./app');
const { createRedis } = require('./redis');
const { createPublisher } = require('./events/publisher');
const { createConsumer } = require('./events/consumer');
const { createSocketServer } = require('./events/socket');
const stepUps = require('./services/stepUps');

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await seedAll({ reset: false });
      log.info(r.seeded ? 'database seeded' : 'database already seeded', { data_dir: r.dir, synthetic: r.synthetic });
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn('database not ready, retrying', { attempt, error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await loadRefs();

  const redis = createRedis('publisher');
  const redisReader = createRedis('consumer');
  let consumer = null;
  const app = createApp({ redis, consumerStats: () => consumer && consumer.stats() });
  const server = http.createServer(app);
  const { deliver } = createSocketServer(server);

  if (env.workers) {
    createPublisher(redis).start();
    consumer = createConsumer(redisReader, deliver);
    await consumer.start();
    setInterval(() => stepUps.expireDue().catch((err) => log.warn('step-up expiry failed', { error: err.message })), env.stepUpSweepMs);
  }

  server.listen(env.port, () => log.info('FraudShield API listening', { port: env.port, instance: env.instanceId }));
}

start().catch((err) => {
  log.error('startup failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
