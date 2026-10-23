// Transactional outbox: domain events are inserted in the same PostgreSQL transaction as the state
// change, so an event exists if and only if the change committed. The publisher moves them to Redis.
// Payloads carry ids and statuses only (card_id and last 4 digits at most), never card numbers.

let kick = () => {};

async function addEvent(client, type, aggregateId, payload, audience = 'staff') {
  await client.query(
    'INSERT INTO outbox_events (event_type, aggregate_id, audience, payload) VALUES ($1, $2, $3, $4)',
    [type, String(aggregateId), audience, JSON.stringify(payload)],
  );
}

// Called after commit so the publisher does not wait for its next poll.
function notifyCommitted() {
  setImmediate(() => kick());
}

function setKick(fn) {
  kick = fn;
}

module.exports = { addEvent, notifyCommitted, setKick };
