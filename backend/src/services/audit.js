// Append-only audit trail (FR-8). Always written inside the same DB transaction as the change it records.

async function audit(client, { entity, entityId, actor, role, action, from = null, to = null, comment = null, details = null }) {
  await client.query(
    `INSERT INTO audit_events (entity, entity_id, actor, role, action, from_status, to_status, comment, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [entity, String(entityId), actor, role, action, from, to, comment, details ? JSON.stringify(details) : null],
  );
}

module.exports = { audit };
