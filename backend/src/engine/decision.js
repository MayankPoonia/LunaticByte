// Decision policy that combines the rules result with the model score (AI-2) and alert policy (6.1.2).

const FRAUD_SUSPICION_CODES = new Set([
  'MERCHANT_BLACKLISTED', 'VELOCITY_BURST', 'IMPOSSIBLE_TRAVEL', 'MULTIPLE_RED_FLAGS',
  'STEP_UP_DENIED', 'STEP_UP_TIMEOUT', 'HIGH_FRAUD_SCORE_MODEL',
]);
const HIGH_PRIORITY_CODES = new Set(['IMPOSSIBLE_TRAVEL', 'MULTIPLE_RED_FLAGS', 'STEP_UP_DENIED']);

const STATUS_FOR_DECISION = { APPROVE: 'APPROVED', STEP_UP: 'STEP_UP_PENDING', BLOCK: 'BLOCKED' };

// The model can only make a decision stricter: APPROVE -> STEP_UP, STEP_UP -> BLOCK. It never relaxes.
function applyModelScore(rules, fraudScore, cfg) {
  if (fraudScore === null || fraudScore === undefined) {
    return { decision: rules.decision, reason_codes: [...rules.reason_codes], model_escalated: false };
  }
  if (rules.decision === 'APPROVE' && fraudScore >= cfg.ai_step_up_threshold) {
    return { decision: 'STEP_UP', reason_codes: [...rules.reason_codes, 'HIGH_FRAUD_SCORE_MODEL'], model_escalated: true };
  }
  if (rules.decision === 'STEP_UP' && fraudScore >= cfg.ai_block_threshold) {
    return { decision: 'BLOCK', reason_codes: [...rules.reason_codes, 'HIGH_FRAUD_SCORE_MODEL'], model_escalated: true };
  }
  return { decision: rules.decision, reason_codes: [...rules.reason_codes], model_escalated: false };
}

function needsAlert(reasonCodes) {
  return reasonCodes.some((c) => FRAUD_SUSPICION_CODES.has(c));
}

function alertPriority(amount, reasonCodes, fraudScore, cfg) {
  if (Number(amount) >= cfg.alert_high_priority_amount) return 'HIGH';
  if (reasonCodes.some((c) => HIGH_PRIORITY_CODES.has(c))) return 'HIGH';
  if (fraudScore !== null && fraudScore !== undefined && fraudScore >= cfg.ai_block_threshold) return 'HIGH';
  return 'MEDIUM';
}

function slaMinutes(priority, cfg) {
  return priority === 'HIGH' ? cfg.sla_high_minutes : cfg.sla_medium_minutes;
}

module.exports = { applyModelScore, needsAlert, alertPriority, slaMinutes, FRAUD_SUSPICION_CODES, STATUS_FOR_DECISION };
