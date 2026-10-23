// Transaction authorisation (FR-2 .. FR-5, AI-2). One PostgreSQL transaction per request:
//   lock card row -> idempotency check -> load config + prior history -> features -> rules R1-R13
//   -> model score (150 ms budget) -> decision policy -> persist txn / step-up / alert / audit / outbox -> commit.
// The card row lock serialises concurrent transactions of the same card, so velocity counts stay correct.
const crypto = require('crypto');
const { withTx } = require('../db');
const log = require('../logger');
const { refs } = require('../data/refs');
const { computeFeatures } = require('../engine/features');
const { evaluateRules } = require('../engine/rules');
const { applyModelScore, needsAlert, alertPriority, slaMinutes, STATUS_FOR_DECISION } = require('../engine/decision');
const { DAY, MINUTE, toIstIso } = require('../engine/time');
const { loadConfig } = require('./ruleConfig');
const { scoreTransaction } = require('./modelClient');
const { audit } = require('./audit');
const { addEvent, notifyCommitted } = require('../events/outbox');
const { ValidationError } = require('../validation');
const { HttpError } = require('../errors');

const round2 = (x) => (x === null || x === undefined ? null : Number(x.toFixed(2)));

function requestHash(t) {
  const canonical = [t.txn_id, t.card_id, new Date(t.ts).toISOString(), t.amount, t.currency, t.merchant_id, t.mcc, t.channel, t.txn_city, t.txn_country].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function normaliseCard(row) {
  return { ...row, daily_limit: Number(row.daily_limit), international_enabled: Boolean(row.international_enabled) };
}

function maskedCard(card) {
  return `XXXXXXXXXXXX${card.last4}`;
}

function replayExisting(row, hash) {
  if (!row.response || row.request_hash !== hash) {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'txn_id was already used for a different transaction');
  }
  return { response: row.response, duplicate: true };
}

async function createStepUp(client, txn, card, cfg, merchant) {
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const otpHash = crypto.createHash('sha256').update(`${txn.txn_id}:${otp}`).digest('hex');
  const { rows } = await client.query(
    `INSERT INTO step_ups (txn_id, card_id, customer_id, otp_hash, status, expires_at)
     VALUES ($1, $2, $3, $4, 'PENDING', now() + make_interval(mins => $5::int)) RETURNING step_up_id, expires_at`,
    [txn.txn_id, card.card_id, card.customer_id, otpHash, cfg.step_up_expiry_minutes],
  );
  const message = `Kaveri National Bank: was this you? INR ${txn.amount} at ${merchant ? merchant.merchant_name : txn.merchant_id} `
    + `on card ${maskedCard(card)}. OTP ${otp}, valid ${cfg.step_up_expiry_minutes} minutes. (simulated message, not sent)`;
  await client.query('INSERT INTO notifications (customer_id, card_id, txn_id, kind, message) VALUES ($1, $2, $3, $4, $5)',
    [card.customer_id, card.card_id, txn.txn_id, 'STEP_UP_OTP', message]);
  // FR-5: the simulated OTP is written to the application log instead of being sent.
  log.info('SIMULATED OTP', { txn_id: txn.txn_id, card: maskedCard(card), otp });
  return rows[0];
}

async function createAlert(client, { txn, card, reasonCodes, fraudScore, createdAt, cfg, actor }) {
  const priority = alertPriority(txn.amount, reasonCodes, fraudScore, cfg);
  const { rows } = await client.query(
    `INSERT INTO alerts (txn_id, card_id, priority, status, reason_codes, amount, fraud_score, sla_due_at, created_at)
     VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7::timestamptz + make_interval(mins => $8::int), $7::timestamptz)
     RETURNING alert_id, priority, sla_due_at, created_at`,
    [txn.txn_id, card.card_id, priority, reasonCodes, txn.amount, fraudScore, createdAt, slaMinutes(priority, cfg)],
  );
  const alert = rows[0];
  await audit(client, { entity: 'ALERT', entityId: alert.alert_id, actor: actor.id, role: actor.role, action: 'ALERT_CREATED', to: 'OPEN',
    details: { txn_id: txn.txn_id, priority, reason_codes: reasonCodes } });
  await addEvent(client, 'alert_created', alert.alert_id, {
    alert_id: Number(alert.alert_id), txn_id: txn.txn_id, card_id: card.card_id, card_last4: card.last4, priority, status: 'OPEN',
    amount: txn.amount, reason_codes: reasonCodes, sla_due_at: alert.sla_due_at, created_at: alert.created_at,
  });
  return alert;
}

/**
 * @param txn   validated transaction from validateTransaction()
 * @param opts  source: API | SIMULATOR | BATCH; mode: 'live' | 'batch'
 *              In batch mode the rules-only decision drives state (decisions_output.csv), step-ups stay
 *              pending without an OTP, and alert creation time is txn_ts (case study 6.1.1 / 6.1.2).
 */
async function authorise(txn, { source = 'API', mode = 'live', actor = { id: 'gateway', role: 'GATEWAY' } } = {}) {
  const started = performance.now();
  const hash = requestHash(txn);
  let result;
  try {
    result = await withTx(async (client) => {
      const cardRes = await client.query('SELECT * FROM cards WHERE card_id = $1 FOR UPDATE', [txn.card_id]);
      if (!cardRes.rows.length) throw new ValidationError([{ field: 'card_id', message: 'unknown card' }]);
      const card = normaliseCard(cardRes.rows[0]);

      const existing = await client.query('SELECT request_hash, response FROM transactions WHERE txn_id = $1', [txn.txn_id]);
      if (existing.rows.length) return replayExisting(existing.rows[0], hash);

      const cfg = await loadConfig(client);
      const lookbackDays = Math.max(cfg.new_merchant_lookback_days, cfg.avg_amount_lookback_days, 1);
      const priorRes = await client.query(
        `SELECT txn_ts, amount, status, merchant_id, channel, txn_city FROM transactions
         WHERE card_id = $1 AND txn_ts >= $2 AND txn_ts < $3`,
        [txn.card_id, new Date(txn.ts - lookbackDays * DAY), new Date(txn.ts)],
      );
      const priors = priorRes.rows.map((r) => ({ ...r, ts: r.txn_ts.getTime() }));
      const merchant = refs.merchants.get(txn.merchant_id);

      const features = computeFeatures(txn, card, priors, refs, cfg);
      const rules = evaluateRules(txn, card, merchant, features, refs, cfg);
      const model = await scoreTransaction(features.model, { timeoutMs: cfg.model_timeout_ms, enabled: cfg.ai_enabled });
      const modelOk = model.model_status === 'OK';
      const ai = modelOk ? applyModelScore(rules, model.fraud_score, cfg) : null;
      const effective = mode === 'batch' || !ai ? { decision: rules.decision, reason_codes: rules.reason_codes } : ai;
      const status = STATUS_FOR_DECISION[effective.decision];
      const processedAt = new Date();

      await client.query(
        `INSERT INTO transactions (txn_id, card_id, txn_ts, amount, currency, merchant_id, mcc, channel, txn_city, txn_country,
           source, status, decision, rules_decision, ai_decision, reason_codes, rule_risk_score, features, rule_results,
           fraud_score, top_factors, model_status, model_version, model_latency_ms, config_version, request_hash, processed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        [txn.txn_id, txn.card_id, new Date(txn.ts), txn.amount, txn.currency, txn.merchant_id, txn.mcc, txn.channel, txn.txn_city,
          txn.txn_country, source, status, effective.decision, rules.decision, ai ? ai.decision : null, effective.reason_codes,
          rules.rule_risk_score, JSON.stringify(features), JSON.stringify(rules.rules), model.fraud_score,
          JSON.stringify(model.top_factors), model.model_status, model.model_version, model.latency_ms, cfg.version, hash, processedAt],
      );
      const fraudScore4 = model.fraud_score === null ? null : Number(model.fraud_score.toFixed(4));
      await audit(client, { entity: 'TRANSACTION', entityId: txn.txn_id, actor: actor.id, role: actor.role, action: 'AUTHORISATION_DECISION',
        from: 'RECEIVED', to: status, comment: effective.reason_codes.join('|') || null,
        details: { decision: effective.decision, rules_decision: rules.decision, rule_risk_score: rules.rule_risk_score,
          fraud_score: fraudScore4, model_status: model.model_status, model_version: model.model_version, config_version: cfg.version, source } });

      let stepUp = null;
      if (status === 'STEP_UP_PENDING' && mode === 'live') stepUp = await createStepUp(client, txn, card, cfg, merchant);

      let alert = null;
      if (status === 'BLOCKED' && needsAlert(effective.reason_codes)) {
        alert = await createAlert(client, {
          txn, card, reasonCodes: effective.reason_codes, fraudScore: mode === 'batch' ? null : model.fraud_score,
          createdAt: mode === 'batch' ? new Date(txn.ts) : processedAt, cfg, actor: { id: 'system', role: 'SYSTEM' },
        });
      }

      const response = {
        txn_id: txn.txn_id,
        decision: effective.decision,
        reason_codes: effective.reason_codes,
        rule_risk_score: rules.rule_risk_score,
        status,
        alert_id: alert ? Number(alert.alert_id) : null,
        processed_at: toIstIso(processedAt.getTime()),
        fraud_score: fraudScore4,
        top_factors: model.top_factors,
        model_status: model.model_status,
        model_version: model.model_version,
        rules_decision: rules.decision,
        step_up: stepUp ? { step_up_id: Number(stepUp.step_up_id), expires_at: stepUp.expires_at } : null,
        features: {
          velocity_10m: features.velocity_10m,
          approved_today: round2(features.approved_today),
          avg_amount_30d: round2(features.avg_amount_30d),
          speed_kmph: round2(features.speed_kmph),
          new_merchant: features.new_merchant,
        },
        model_latency_ms: model.latency_ms,
        processing_ms: Math.round((performance.now() - started) * 100) / 100,
      };
      await client.query('UPDATE transactions SET response = $2, processing_ms = $3 WHERE txn_id = $1',
        [txn.txn_id, JSON.stringify(response), response.processing_ms]);

      await addEvent(client, 'transaction_decided', txn.txn_id, {
        txn_id: txn.txn_id, card_id: card.card_id, card_last4: card.last4, amount: txn.amount, channel: txn.channel, txn_city: txn.txn_city,
        decision: effective.decision, status, reason_codes: effective.reason_codes, fraud_score: response.fraud_score,
        model_status: model.model_status, alert_id: response.alert_id, source, processed_at: response.processed_at,
      });
      if (stepUp) {
        await addEvent(client, 'step_up_updated', txn.txn_id, { txn_id: txn.txn_id, step_up_id: Number(stepUp.step_up_id), status: 'PENDING', card_last4: card.last4 },
          `customer:${card.customer_id}`);
      }
      return { response, duplicate: false };
    });
  } catch (err) {
    // Same txn_id submitted concurrently for different cards: the primary key decides; replay the winner.
    if (err.code === '23505' && err.constraint === 'transactions_pkey') {
      const { query } = require('../db');
      const { rows } = await query('SELECT request_hash, response FROM transactions WHERE txn_id = $1', [txn.txn_id]);
      return replayExisting(rows[0], hash);
    }
    throw err;
  }
  if (!result.duplicate) notifyCommitted();
  return result;
}

module.exports = { authorise, requestHash, maskedCard, createAlert, MINUTE };
