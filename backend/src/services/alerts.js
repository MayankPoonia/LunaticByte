// Alert queue and investigation workflow (FR-6, FR-7):
//   OPEN --claim--> IN_REVIEW --close--> CONFIRMED_FRAUD | FALSE_POSITIVE
//                              \--FALSE_POSITIVE above maker-checker limit--> PENDING_MANAGER_APPROVAL
//   PENDING_MANAGER_APPROVAL --manager APPROVE--> FALSE_POSITIVE, --REJECT--> CONFIRMED_FRAUD
// All transitions use row locks / conditional updates so two users cannot both succeed (HTTP 409).
const { query, withTx } = require('../db');
const { loadConfig } = require('./ruleConfig');
const { audit } = require('./audit');
const { blockCard } = require('./cards');
const { addEvent, notifyCommitted } = require('../events/outbox');
const { HttpError } = require('../errors');

const ACTIVE = ['OPEN', 'IN_REVIEW', 'PENDING_MANAGER_APPROVAL'];
const MIN_COMMENT = 10;

const LIST_SQL = `
  SELECT a.alert_id, a.txn_id, a.card_id, c.last4 AS card_last4, a.priority, a.status, a.reason_codes, a.amount, a.fraud_score,
         a.sla_due_at, a.created_at, a.claimed_by, cu.display_name AS claimed_by_name, a.claimed_at, a.proposed_by,
         pu.display_name AS proposed_by_name, a.closed_at, t.txn_ts, t.channel, t.txn_city, t.merchant_id, m.merchant_name,
         (CASE WHEN a.status = ANY($1) THEN now() > a.sla_due_at ELSE a.closed_at > a.sla_due_at END) AS sla_breached
  FROM alerts a
  JOIN transactions t ON t.txn_id = a.txn_id
  JOIN cards c ON c.card_id = a.card_id
  LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
  LEFT JOIN users cu ON cu.user_id = a.claimed_by
  LEFT JOIN users pu ON pu.user_id = a.proposed_by`;

function shape(row) {
  return { ...row, alert_id: Number(row.alert_id), fraud_score: row.fraud_score === null ? null : Number(row.fraud_score) };
}

// Queue ordered by priority (HIGH first) then sla_due_at.
async function listAlerts({ status = 'active', priority, limit = 200 } = {}) {
  const where = [];
  const params = [ACTIVE];
  if (status === 'active') where.push('a.status = ANY($1)');
  else if (status === 'closed') where.push("a.status IN ('CONFIRMED_FRAUD', 'FALSE_POSITIVE')");
  else if (status !== 'all') {
    params.push(status);
    where.push(`a.status = $${params.length}`);
  }
  if (priority) {
    params.push(priority);
    where.push(`a.priority = $${params.length}`);
  }
  params.push(Math.min(Number(limit) || 200, 500));
  const sql = `${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE a.priority WHEN 'HIGH' THEN 0 ELSE 1 END, a.sla_due_at, a.alert_id LIMIT $${params.length}`;
  const { rows } = await query(sql, params);
  return rows.map(shape);
}

async function getAlert(alertId) {
  const { rows } = await query(`${LIST_SQL} WHERE a.alert_id = $2`, [ACTIVE, alertId]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Alert not found');
  const alert = shape(rows[0]);
  const full = await query('SELECT analyst_comment, manager_id, manager_comment, proposed_at FROM alerts WHERE alert_id = $1', [alertId]);
  Object.assign(alert, full.rows[0]);

  const txn = (await query(
    `SELECT txn_id, card_id, txn_ts, amount, currency, merchant_id, mcc, channel, txn_city, txn_country, source, status, decision,
            rules_decision, ai_decision, reason_codes, rule_risk_score, features, rule_results, fraud_score, top_factors,
            model_status, model_version, model_latency_ms, config_version, processed_at, processing_ms
     FROM transactions WHERE txn_id = $1`, [alert.txn_id])).rows[0];
  const card = (await query(
    `SELECT card_id, last4, card_type, card_status, expiry_date, home_city, home_country, daily_limit, international_enabled, issue_date
     FROM cards WHERE card_id = $1`, [alert.card_id])).rows[0];
  const history = (await query(
    `SELECT t.txn_id, t.txn_ts, t.amount, t.merchant_id, m.merchant_name, t.channel, t.txn_city, t.txn_country, t.status, t.reason_codes, t.source
     FROM transactions t LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     WHERE t.card_id = $1 AND t.txn_ts <= $2 ORDER BY t.txn_ts DESC LIMIT 25`, [alert.card_id, txn.txn_ts])).rows;
  return { alert, transaction: txn, card: { ...card, masked: `XXXXXXXXXXXX${card.last4}` }, card_history: history };
}

async function lockAlert(client, alertId) {
  const { rows } = await client.query('SELECT * FROM alerts WHERE alert_id = $1 FOR UPDATE', [alertId]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Alert not found');
  return rows[0];
}

async function emitAlert(client, alert, status, extra = {}) {
  await addEvent(client, 'alert_updated', alert.alert_id, {
    alert_id: Number(alert.alert_id), txn_id: alert.txn_id, priority: alert.priority, status, ...extra,
  });
}

function validateComment(comment) {
  if (typeof comment !== 'string' || comment.trim().length < MIN_COMMENT) {
    throw new HttpError(422, 'VALIDATION_ERROR', `comment must be at least ${MIN_COMMENT} characters`,
      [{ field: 'comment', message: `must be at least ${MIN_COMMENT} characters` }]);
  }
  return comment.trim();
}

async function claimAlert(alertId, user) {
  const result = await withTx(async (client) => {
    // Conditional update: only one analyst can move OPEN -> IN_REVIEW.
    const { rows } = await client.query(
      `UPDATE alerts SET status = 'IN_REVIEW', claimed_by = $2, claimed_at = now(), updated_at = now()
       WHERE alert_id = $1 AND status = 'OPEN' RETURNING *`, [alertId, user.user_id]);
    if (!rows.length) {
      const cur = await client.query('SELECT status, claimed_by FROM alerts WHERE alert_id = $1', [alertId]);
      if (!cur.rows.length) throw new HttpError(404, 'NOT_FOUND', 'Alert not found');
      throw new HttpError(409, 'ALERT_ALREADY_CLAIMED', `Alert is ${cur.rows[0].status}`, { status: cur.rows[0].status, claimed_by: cur.rows[0].claimed_by });
    }
    const alert = rows[0];
    await audit(client, { entity: 'ALERT', entityId: alertId, actor: user.user_id, role: user.role, action: 'ALERT_CLAIMED', from: 'OPEN', to: 'IN_REVIEW' });
    await emitAlert(client, alert, 'IN_REVIEW', { claimed_by: user.user_id, claimed_by_name: user.display_name });
    return shape(alert);
  });
  notifyCommitted();
  return result;
}

async function finalise(client, alert, outcome, actor, comment, cfgNote) {
  if (outcome === 'CONFIRMED_FRAUD') {
    await blockCard(client, alert.card_id, actor, `Confirmed fraud on alert ${alert.alert_id}`);
  } else {
    const card = (await client.query('SELECT customer_id, last4 FROM cards WHERE card_id = $1', [alert.card_id])).rows[0];
    await client.query('INSERT INTO notifications (customer_id, card_id, txn_id, kind, message) VALUES ($1, $2, $3, $4, $5)',
      [card.customer_id, alert.card_id, alert.txn_id, 'FALSE_POSITIVE_NOTICE',
        `Kaveri National Bank: our review of transaction ${alert.txn_id} on card XXXXXXXXXXXX${card.last4} found it genuine. We apologise for the inconvenience. (simulated message, not sent)`]);
  }
  // Analyst outcomes are stored as feedback labels for the next training run.
  await client.query(`INSERT INTO model_feedback (txn_id, label, source) VALUES ($1, $2, $3)
    ON CONFLICT (txn_id) DO UPDATE SET label = EXCLUDED.label, source = EXCLUDED.source, created_at = now()`,
  [alert.txn_id, outcome === 'CONFIRMED_FRAUD' ? 1 : 0, cfgNote]);
  return comment;
}

async function closeAlert(alertId, user, { outcome, comment }) {
  if (!['CONFIRMED_FRAUD', 'FALSE_POSITIVE'].includes(outcome)) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'outcome must be CONFIRMED_FRAUD or FALSE_POSITIVE', [{ field: 'outcome', message: 'must be CONFIRMED_FRAUD or FALSE_POSITIVE' }]);
  }
  const text = validateComment(comment);
  const actor = { id: user.user_id, role: user.role };
  const result = await withTx(async (client) => {
    const alert = await lockAlert(client, alertId);
    if (alert.status !== 'IN_REVIEW') throw new HttpError(409, 'ALERT_NOT_IN_REVIEW', `Alert is ${alert.status}`);
    if (alert.claimed_by !== user.user_id) throw new HttpError(409, 'ALERT_LOCKED', 'Alert is claimed by another analyst');
    const cfg = await loadConfig(client);

    if (outcome === 'FALSE_POSITIVE' && Number(alert.amount) > cfg.maker_checker_limit) {
      await client.query(
        `UPDATE alerts SET status = 'PENDING_MANAGER_APPROVAL', proposed_by = $2, proposed_at = now(), analyst_comment = $3, updated_at = now()
         WHERE alert_id = $1`, [alertId, user.user_id, text]);
      await audit(client, { entity: 'ALERT', entityId: alertId, actor: actor.id, role: actor.role, action: 'FALSE_POSITIVE_PROPOSED',
        from: 'IN_REVIEW', to: 'PENDING_MANAGER_APPROVAL', comment: text, details: { amount: alert.amount, limit: cfg.maker_checker_limit } });
      await emitAlert(client, alert, 'PENDING_MANAGER_APPROVAL');
      return { alert_id: Number(alertId), status: 'PENDING_MANAGER_APPROVAL' };
    }

    await client.query(`UPDATE alerts SET status = $2, analyst_comment = $3, closed_at = now(), updated_at = now() WHERE alert_id = $1`,
      [alertId, outcome, text]);
    await audit(client, { entity: 'ALERT', entityId: alertId, actor: actor.id, role: actor.role, action: 'ALERT_CLOSED', from: 'IN_REVIEW', to: outcome, comment: text });
    await finalise(client, alert, outcome, actor, text, 'ANALYST');
    await emitAlert(client, alert, outcome);
    return { alert_id: Number(alertId), status: outcome };
  });
  notifyCommitted();
  return result;
}

async function managerDecision(alertId, user, { decision, comment }) {
  if (!['APPROVE', 'REJECT'].includes(decision)) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'decision must be APPROVE or REJECT', [{ field: 'decision', message: 'must be APPROVE or REJECT' }]);
  }
  const text = validateComment(comment);
  const actor = { id: user.user_id, role: user.role };
  const result = await withTx(async (client) => {
    const alert = await lockAlert(client, alertId);
    if (alert.status !== 'PENDING_MANAGER_APPROVAL') throw new HttpError(409, 'ALERT_NOT_PENDING_APPROVAL', `Alert is ${alert.status}`);
    // Maker and checker must differ.
    if (alert.proposed_by === user.user_id) throw new HttpError(403, 'MAKER_CHECKER_VIOLATION', 'The proposer cannot approve their own proposal');
    const outcome = decision === 'APPROVE' ? 'FALSE_POSITIVE' : 'CONFIRMED_FRAUD';
    await client.query(`UPDATE alerts SET status = $2, manager_id = $3, manager_comment = $4, closed_at = now(), updated_at = now() WHERE alert_id = $1`,
      [alertId, outcome, user.user_id, text]);
    await audit(client, { entity: 'ALERT', entityId: alertId, actor: actor.id, role: actor.role, action: `MANAGER_${decision}`,
      from: 'PENDING_MANAGER_APPROVAL', to: outcome, comment: text });
    await finalise(client, alert, outcome, actor, text, 'MANAGER');
    await emitAlert(client, alert, outcome);
    return { alert_id: Number(alertId), status: outcome };
  });
  notifyCommitted();
  return result;
}

module.exports = { listAlerts, getAlert, claimAlert, closeAlert, managerDecision, ACTIVE };
