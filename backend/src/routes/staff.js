// Staff (analyst / manager) read APIs: transactions, cards, alerts, dashboard, audit.
const express = require('express');
const { query } = require('../db');
const { requireUser, requireRole, STAFF } = require('../middleware/auth');
const alerts = require('../services/alerts');
const { HttpError } = require('../errors');

const router = express.Router();
const staff = [requireUser, requireRole(...STAFF)];
const analyst = [requireUser, requireRole('ANALYST')];
const manager = [requireUser, requireRole('MANAGER')];

const TXN_COLUMNS = `t.txn_id, t.card_id, c.last4 AS card_last4, t.txn_ts, t.amount, t.currency, t.merchant_id, m.merchant_name, t.mcc,
  t.channel, t.txn_city, t.txn_country, t.source, t.status, t.decision, t.rules_decision, t.ai_decision, t.reason_codes,
  t.rule_risk_score, t.fraud_score, t.model_status, t.processing_ms, t.processed_at`;

// ---------------------------------------------------------------- transactions
router.get('/transactions', staff, async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  const source = req.query.source || 'live';
  if (source === 'live') where.push("t.source <> 'HISTORY'");
  else if (source !== 'all') add('t.source = ?', source);
  if (req.query.status) add('t.status = ?', req.query.status);
  if (req.query.decision) add('t.decision = ?', req.query.decision);
  if (req.query.card_id) add('t.card_id = ?', req.query.card_id);
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where.push(`(t.txn_id ILIKE $${params.length} OR t.card_id ILIKE $${params.length})`);
  }
  params.push(Math.min(Number(req.query.limit) || 100, 500));
  const order = source === 'live' ? 't.processed_at DESC NULLS LAST' : 't.txn_ts DESC';
  const { rows } = await query(
    `SELECT ${TXN_COLUMNS} FROM transactions t JOIN cards c ON c.card_id = t.card_id LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT $${params.length}`, params);
  res.json({ transactions: rows });
});

router.get('/transactions/:id', staff, async (req, res) => {
  const { rows } = await query(
    `SELECT ${TXN_COLUMNS}, t.features, t.rule_results, t.top_factors, t.model_version, t.model_latency_ms, t.config_version, t.response,
       m.merchant_risk, m.city AS merchant_city
     FROM transactions t JOIN cards c ON c.card_id = t.card_id LEFT JOIN merchants m ON m.merchant_id = t.merchant_id WHERE t.txn_id = $1`, [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Transaction not found');
  const stepUp = await query('SELECT step_up_id, status, attempts, expires_at, created_at, resolved_at FROM step_ups WHERE txn_id = $1', [req.params.id]);
  const alert = await query('SELECT alert_id, priority, status, sla_due_at FROM alerts WHERE txn_id = $1', [req.params.id]);
  const auditRows = await query("SELECT * FROM audit_events WHERE entity = 'TRANSACTION' AND entity_id = $1 ORDER BY audit_id", [req.params.id]);
  res.json({ transaction: rows[0], step_up: stepUp.rows[0] || null, alert: alert.rows[0] || null, audit: auditRows.rows });
});

router.get('/cards/:id', staff, async (req, res) => {
  const { rows } = await query(
    `SELECT card_id, customer_id, last4, card_type, card_status, issue_date, expiry_date, home_city, home_country, daily_limit, international_enabled
     FROM cards WHERE card_id = $1`, [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Card not found');
  const txns = await query(
    `SELECT ${TXN_COLUMNS} FROM transactions t JOIN cards c ON c.card_id = t.card_id LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     WHERE t.card_id = $1 ORDER BY t.txn_ts DESC LIMIT 50`, [req.params.id]);
  res.json({ card: { ...rows[0], masked: `XXXXXXXXXXXX${rows[0].last4}` }, transactions: txns.rows });
});

// ---------------------------------------------------------------- alerts
router.get('/alerts', staff, async (req, res) => {
  res.json({ alerts: await alerts.listAlerts({ status: req.query.status, priority: req.query.priority, limit: req.query.limit }) });
});
router.get('/alerts/:id', staff, async (req, res) => res.json(await alerts.getAlert(req.params.id)));
router.post('/alerts/:id/claim', analyst, async (req, res) => res.json(await alerts.claimAlert(req.params.id, req.user)));
router.post('/alerts/:id/close', analyst, async (req, res) => res.json(await alerts.closeAlert(req.params.id, req.user, req.body || {})));
router.post('/alerts/:id/manager-decision', manager, async (req, res) => res.json(await alerts.managerDecision(req.params.id, req.user, req.body || {})));

// ---------------------------------------------------------------- dashboard (FR-9)
router.get('/dashboard/summary', staff, async (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2999-12-31';
  const range = [from, to];
  const inRange = "t.source <> 'HISTORY' AND (t.txn_ts AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date";
  const [byDecision, byStatus, model, latency, reasons, openAlerts, breaches, closed, total] = await Promise.all([
    query(`SELECT decision, count(*)::int AS n FROM transactions t WHERE ${inRange} GROUP BY decision`, range),
    query(`SELECT status, count(*)::int AS n FROM transactions t WHERE ${inRange} GROUP BY status`, range),
    query(`SELECT model_status, count(*)::int AS n, count(*) FILTER (WHERE ai_decision IS DISTINCT FROM rules_decision AND ai_decision IS NOT NULL)::int AS escalated
           FROM transactions t WHERE ${inRange} GROUP BY model_status`, range),
    query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY processing_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY processing_ms) AS p95,
           count(*)::int AS n FROM transactions t WHERE ${inRange} AND source IN ('API', 'SIMULATOR')`, range),
    query(`SELECT code, count(*)::int AS n FROM transactions t, unnest(t.reason_codes) AS code WHERE ${inRange} GROUP BY code ORDER BY n DESC, code LIMIT 5`, range),
    query(`SELECT priority, count(*)::int AS n FROM alerts WHERE status = ANY($1) GROUP BY priority`, [alerts.ACTIVE]),
    query(`SELECT count(*) FILTER (WHERE status = ANY($1) AND now() > sla_due_at)::int AS open_breached,
                  count(*) FILTER (WHERE closed_at IS NOT NULL AND closed_at > sla_due_at AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date)::int AS closed_late
           FROM alerts`, [alerts.ACTIVE, from, to]),
    query(`SELECT status, count(*)::int AS n FROM alerts WHERE status IN ('CONFIRMED_FRAUD', 'FALSE_POSITIVE')
           AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date GROUP BY status`, range),
    query(`SELECT count(*)::int AS n FROM transactions t WHERE ${inRange}`, range),
  ]);
  const toMap = (rows, k) => Object.fromEntries(rows.map((r) => [r[k] || 'NONE', r.n]));
  const decisions = toMap(byDecision.rows, 'decision');
  const n = total.rows[0].n;
  const closedMap = toMap(closed.rows, 'status');
  const closedTotal = (closedMap.CONFIRMED_FRAUD || 0) + (closedMap.FALSE_POSITIVE || 0);
  res.json({
    range: { from, to },
    transactions: { total: n, by_decision: decisions, by_status: toMap(byStatus.rows, 'status') },
    rates: {
      block_rate: n ? (decisions.BLOCK || 0) / n : 0,
      step_up_rate: n ? (decisions.STEP_UP || 0) / n : 0,
      false_positive_rate: closedTotal ? (closedMap.FALSE_POSITIVE || 0) / closedTotal : 0,
    },
    alerts: {
      open_by_priority: toMap(openAlerts.rows, 'priority'),
      sla_breached_open: breaches.rows[0].open_breached,
      sla_breached_closed_late: breaches.rows[0].closed_late,
      closed: closedMap,
    },
    top_reason_codes: reasons.rows,
    model: {
      by_status: toMap(model.rows, 'model_status'),
      escalations: model.rows.reduce((s, r) => s + r.escalated, 0),
    },
    latency_ms: { p50: latency.rows[0].p50 === null ? null : Number(latency.rows[0].p50), p95: latency.rows[0].p95 === null ? null : Number(latency.rows[0].p95), samples: latency.rows[0].n },
  });
});

// ---------------------------------------------------------------- audit (FR-8)
const ENTITIES = ['TRANSACTION', 'ALERT', 'CARD', 'CONFIG', 'STEP_UP'];

function toCsv(rows) {
  const cols = ['audit_id', 'ts', 'entity', 'entity_id', 'actor', 'role', 'action', 'from_status', 'to_status', 'comment'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

router.get('/audit', staff, async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.entity) {
    params.push(String(req.query.entity).toUpperCase());
    where.push(`entity = $${params.length}`);
  }
  if (req.query.actor) {
    params.push(req.query.actor);
    where.push(`actor = $${params.length}`);
  }
  params.push(Math.min(Number(req.query.limit) || 200, 1000));
  const { rows } = await query(`SELECT * FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY audit_id DESC LIMIT $${params.length}`, params);
  res.json({ events: rows });
});

router.get('/audit/:entity/:id', staff, async (req, res) => {
  const entity = String(req.params.entity).toUpperCase();
  if (!ENTITIES.includes(entity)) throw new HttpError(400, 'VALIDATION_ERROR', `entity must be one of ${ENTITIES.join(', ')}`);
  let rows;
  if (entity === 'TRANSACTION') {
    // A transaction's history includes its step-up and alert events.
    ({ rows } = await query(
      `SELECT * FROM audit_events WHERE (entity = 'TRANSACTION' AND entity_id = $1)
         OR (entity = 'ALERT' AND entity_id IN (SELECT alert_id::text FROM alerts WHERE txn_id = $1))
         OR (entity = 'STEP_UP' AND entity_id IN (SELECT step_up_id::text FROM step_ups WHERE txn_id = $1))
       ORDER BY audit_id`, [req.params.id]));
  } else {
    ({ rows } = await query('SELECT * FROM audit_events WHERE entity = $1 AND entity_id = $2 ORDER BY audit_id', [entity, req.params.id]));
  }
  if (req.query.format === 'csv') {
    res.set('content-type', 'text/csv');
    res.set('content-disposition', `attachment; filename="audit_${entity.toLowerCase()}_${req.params.id}.csv"`);
    return res.send(toCsv(rows));
  }
  return res.json({ entity, entity_id: req.params.id, events: rows });
});

module.exports = router;
