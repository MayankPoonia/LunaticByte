// Rules engine R1-R13 (case study 6.1). Thresholds, points and lists come from configuration.
// Evaluation order and precedence:
//   1. R1, R2 are hard stops: if either triggers, evaluation stops (score and derived fields empty).
//   2. R3-R6 are blocking rules: if any triggers, decision BLOCK, score 100, R7-R13 not evaluated.
//   3. R7-R12 are soft (STEP_UP) rules with points; R13 blocks when 3+ of them trigger.
const { istMinuteOfDay } = require('./time');

const fmt = (n) => (n === null || n === undefined ? 'n/a' : Number(n).toFixed(2));

function evaluateRules(txn, card, merchant, features, refs, cfg) {
  const amount = Number(txn.amount);
  const results = [];
  const check = (rule, code, triggered, detail, points) => {
    results.push({ rule, code, triggered: Boolean(triggered), detail, ...(points !== undefined ? { points } : {}) });
    return Boolean(triggered);
  };

  // ---- hard stops
  const expired = card.expiry_date < features.txn_date;
  check('R1', 'CARD_NOT_ACTIVE', card.card_status !== 'ACTIVE' || expired,
    `card_status ${card.card_status}, expiry ${card.expiry_date}, transaction date ${features.txn_date}`);
  check('R2', 'INTL_NOT_ENABLED', txn.txn_country !== cfg.domestic_country && !card.international_enabled,
    `txn_country ${txn.txn_country}, international_enabled ${card.international_enabled ? 'Y' : 'N'}`);
  const hard = results.filter((r) => r.triggered);
  if (hard.length) {
    return { decision: 'BLOCK', reason_codes: hard.map((r) => r.code), rule_risk_score: null, hard_stop: true, rules: results };
  }

  // ---- blocking rules R3-R6 (all evaluated so every triggered code is listed)
  check('R3', 'MERCHANT_BLACKLISTED', merchant && merchant.merchant_risk === 'BLACKLISTED',
    `merchant_risk ${merchant ? merchant.merchant_risk : 'unknown'}`);
  check('R4', 'DAILY_LIMIT_EXCEEDED', features.approved_today + amount > Number(card.daily_limit),
    `approved_today ${fmt(features.approved_today)} + amount ${fmt(amount)} vs daily_limit ${fmt(card.daily_limit)}`);
  check('R5', 'VELOCITY_BURST', features.velocity_10m >= cfg.velocity_burst_count,
    `velocity_10m ${features.velocity_10m} (burst at ${cfg.velocity_burst_count})`);
  check('R6', 'IMPOSSIBLE_TRAVEL', features.speed_kmph !== null && features.speed_kmph > cfg.impossible_travel_speed_kmph,
    `speed_kmph ${fmt(features.speed_kmph)} (limit ${cfg.impossible_travel_speed_kmph})`);
  const blocking = results.filter((r) => r.triggered);
  if (blocking.length) {
    return { decision: 'BLOCK', reason_codes: blocking.map((r) => r.code), rule_risk_score: 100, hard_stop: false, rules: results };
  }

  // ---- soft rules R7-R12
  const p = cfg.points;
  check('R7', 'HIGH_VELOCITY',
    features.velocity_10m >= cfg.velocity_step_up_count && features.velocity_10m <= cfg.velocity_step_up_max,
    `velocity_10m ${features.velocity_10m} (step-up at ${cfg.velocity_step_up_count} to ${cfg.velocity_step_up_max})`, p.R7);

  const avg = features.avg_amount_30d;
  const spike = avg !== null
    ? amount > cfg.amount_spike_multiplier * avg && amount >= cfg.amount_spike_min_amount
    : amount >= cfg.amount_spike_no_history_amount;
  check('R8', 'AMOUNT_SPIKE', spike, avg !== null
    ? `amount ${fmt(amount)} vs ${cfg.amount_spike_multiplier} x avg_amount_30d ${fmt(avg)} = ${fmt(cfg.amount_spike_multiplier * avg)}`
    : `no 30-day history; amount ${fmt(amount)} vs ${fmt(cfg.amount_spike_no_history_amount)}`, p.R8);

  const countryRisk = refs.countryRisk.get(txn.txn_country);
  check('R9', 'HIGH_RISK_GEO', txn.txn_country !== card.home_country && countryRisk === 'HIGH',
    `txn_country ${txn.txn_country} (risk ${countryRisk || 'unknown'}), home_country ${card.home_country}`, p.R9);

  check('R10', 'HIGH_RISK_MCC', cfg.high_risk_mcc_list.includes(String(txn.mcc)),
    `mcc ${txn.mcc}; high-risk list ${cfg.high_risk_mcc_list.join(', ')}`, p.R10);

  const minute = istMinuteOfDay(txn.ts);
  // Odd hours are whole IST hours, inclusive: start 0 and end 4 mean 00:00 to 04:59.
  const oddHour = minute >= cfg.odd_hour_start * 60 && minute <= cfg.odd_hour_end * 60 + 59;
  check('R11', 'ODD_HOUR_HIGH_VALUE', oddHour && amount >= cfg.odd_hour_min_amount,
    `local time ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} IST, amount ${fmt(amount)}`, p.R11);

  check('R12', 'NEW_MERCHANT_HIGH_VALUE', txn.channel === 'ECOM' && features.new_merchant && amount >= cfg.new_merchant_min_amount,
    `channel ${txn.channel}, new merchant ${features.new_merchant ? 'yes' : 'no'}, amount ${fmt(amount)}`, p.R12);

  const soft = results.filter((r) => r.triggered && r.points !== undefined);
  const codes = soft.map((r) => r.code);
  const score = Math.min(soft.reduce((s, r) => s + r.points, 0), cfg.rule_risk_score_cap);
  const redFlags = check('R13', 'MULTIPLE_RED_FLAGS', soft.length >= cfg.multiple_red_flags_count,
    `${soft.length} soft rules triggered (block at ${cfg.multiple_red_flags_count})`);

  if (redFlags) return { decision: 'BLOCK', reason_codes: [...codes, 'MULTIPLE_RED_FLAGS'], rule_risk_score: score, hard_stop: false, rules: results };
  if (soft.length) return { decision: 'STEP_UP', reason_codes: codes, rule_risk_score: score, hard_stop: false, rules: results };
  return { decision: 'APPROVE', reason_codes: [], rule_risk_score: 0, hard_stop: false, rules: results };
}

module.exports = { evaluateRules };
