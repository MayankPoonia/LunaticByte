// Outbox publisher: copies committed outbox rows to the Redis Stream and marks them published.
// FOR UPDATE SKIP LOCKED lets several backend replicas publish without sending a row twice.
// If Redis is down the rows stay unpublished (attempts / last_error recorded) and are retried.
const { withTx } = require('../db');
const env = require('../env');
const log = require('../logger');
const { setKick } = require('./outbox');

function createPublisher(redis, { streamKey = env.streamKey, pollMs = env.outboxPollMs } = {}) {
  let running = false;
  let again = false;
  let timer = null;

  async function publishOnce(limit = 200) {
    return withTx(async (client) => {
      const { rows } = await client.query(
        `SELECT event_id, event_type, aggregate_id, audience, payload, created_at FROM outbox_events
         WHERE published_at IS NULL ORDER BY event_id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
      const published = [];
      let failure = null;
      for (const row of rows) {
        try {
          await redis.xadd(streamKey, 'MAXLEN', '~', '10000', '*',
            'event_id', String(row.event_id), 'type', row.event_type, 'audience', row.audience,
            'aggregate_id', row.aggregate_id, 'created_at', row.created_at.toISOString(), 'payload', JSON.stringify(row.payload));
          published.push(row.event_id);
        } catch (err) {
          failure = { ids: rows.slice(published.length).map((r) => r.event_id), error: err.message };
          break;
        }
      }
      if (published.length) await client.query('UPDATE outbox_events SET published_at = now() WHERE event_id = ANY($1)', [published]);
      if (failure) {
        await client.query('UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE event_id = ANY($1)', [failure.ids, failure.error]);
      }
      return { published: published.length, failed: failure ? failure.ids.length : 0 };
    });
  }

  async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const r = await publishOnce();
        if (r.failed) log.debug('outbox publish deferred', r);
        if (r.published === 200) again = true;
      } while (again);
    } catch (err) {
      log.warn('outbox publisher error', { error: err.message });
    } finally {
      running = false;
    }
  }

  return {
    publishOnce,
    start() {
      setKick(run);
      timer = setInterval(run, pollMs);
      run();
    },
    stop() {
      clearInterval(timer);
      setKick(() => {});
    },
  };
}

module.exports = { createPublisher };
