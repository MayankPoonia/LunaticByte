// Card status changes. Later transactions on a BLOCKED card are declined by R1. Unblocking is out of scope.
const { audit } = require('./audit');
const { addEvent } = require('../events/outbox');

async function blockCard(client, cardId, actor, reason) {
  const { rows } = await client.query('SELECT card_id, card_status, last4, customer_id FROM cards WHERE card_id = $1 FOR UPDATE', [cardId]);
  const card = rows[0];
  if (!card || card.card_status === 'BLOCKED') return card;
  await client.query("UPDATE cards SET card_status = 'BLOCKED', updated_at = now() WHERE card_id = $1", [cardId]);
  await audit(client, { entity: 'CARD', entityId: cardId, actor: actor.id, role: actor.role, action: 'CARD_BLOCKED',
    from: card.card_status, to: 'BLOCKED', comment: reason });
  const payload = { card_id: cardId, card_last4: card.last4, card_status: 'BLOCKED', reason };
  await addEvent(client, 'card_updated', cardId, payload);
  await addEvent(client, 'card_updated', cardId, payload, `customer:${card.customer_id}`);
  return { ...card, card_status: 'BLOCKED' };
}

module.exports = { blockCard };
