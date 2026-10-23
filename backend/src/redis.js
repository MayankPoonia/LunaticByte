// Redis connections. Commands fail fast while Redis is down (no offline queue), so the outbox
// simply retries later and the authorisation path is never blocked by Redis.
const Redis = require('ioredis');
const env = require('./env');
const log = require('./logger');

function createRedis(name, url = env.redisUrl) {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  let warned = false;
  client.on('error', (err) => {
    if (!warned) log.warn(`redis ${name} error`, { error: err.message });
    warned = true;
  });
  client.on('ready', () => {
    warned = false;
    log.info(`redis ${name} ready`);
  });
  return client;
}

module.exports = { createRedis };
