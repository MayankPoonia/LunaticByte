// Redis Stream consumer that pushes events to connected browsers via Socket.IO.
// Each backend replica uses its own consumer group, so every replica sees every event and can
// notify the sockets connected to it. Entries are acknowledged (XACK) only after they were handled,
// and already-seen event_ids are skipped, so redelivery is harmless.
const env = require('../env');
const log = require('../logger');

function createConsumer(redis, deliver, { streamKey = env.streamKey, group = `ws-${env.instanceId}`, consumer = env.instanceId } = {}) {
  let stopped = false;
  let markReady;
  const ready = new Promise((r) => (markReady = r));
  const seen = new Set();
  const seenOrder = [];
  const latencies = [];

  function remember(id) {
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > 5000) seen.delete(seenOrder.shift());
  }

  async function ensureGroup() {
    try {
      await redis.xgroup('CREATE', streamKey, group, '$', 'MKSTREAM');
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
  }

  function toEvent(fields) {
    const obj = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    return { event_id: obj.event_id, type: obj.type, audience: obj.audience, created_at: obj.created_at, payload: JSON.parse(obj.payload || '{}') };
  }

  async function handle(entries) {
    for (const [streamId, fields] of entries) {
      const event = toEvent(fields);
      if (!seen.has(event.event_id)) {
        remember(event.event_id);
        deliver(event);
        const lag = Date.now() - Date.parse(event.created_at);
        latencies.push(lag);
        if (latencies.length > 500) latencies.shift();
      }
      await redis.xack(streamKey, group, streamId);
    }
  }

  async function loop() {
    let pendingFirst = true; // after a restart, first re-read entries delivered but never acknowledged
    while (!stopped) {
      try {
        if (redis.status !== 'ready') {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        await ensureGroup();
        markReady(true);
        const res = await redis.xreadgroup('GROUP', group, consumer, 'COUNT', 100, 'BLOCK', 1000, 'STREAMS', streamKey, pendingFirst ? '0' : '>');
        const entries = res ? res[0][1] : [];
        if (pendingFirst && entries.length === 0) pendingFirst = false;
        await handle(entries);
      } catch (err) {
        if (!stopped) {
          log.debug('stream consumer retry', { error: err.message });
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  return {
    // Resolves once the consumer group exists (or after 3 s if Redis is unavailable), so the
    // server only accepts traffic when events can be delivered.
    start() {
      loop();
      return Promise.race([ready, new Promise((r) => setTimeout(() => r(false), 3000))]);
    },
    stop() {
      stopped = true;
    },
    handle,
    stats() {
      const sorted = [...latencies].sort((a, b) => a - b);
      const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
      return { group, delivered: latencies.length, p50_ms: pct(50), p95_ms: pct(95), max_ms: sorted.length ? sorted[sorted.length - 1] : null };
    },
  };
}

module.exports = { createConsumer };
