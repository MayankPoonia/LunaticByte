// Rule configuration (FR-4, NFR "Configurability").
// Every threshold, window, point value, list, SLA and AI threshold lives in the rule_config table,
// seeded from case_01_rules_config_*.json. Defaults below are the values printed in the case study
// and are used only for parameters the JSON file does not provide (the seed report lists which).
const { query } = require('../db');

// key, default, description, aliases (matched against the end of the flattened JSON path)
const PARAMS = [
  ['velocity_window_minutes', 10, 'Velocity window in minutes (R5, R7)', ['velocity_window', 'velocity.window_minutes', 'velocity_10m_window_minutes']],
  ['velocity_burst_count', 5, 'velocity_10m at or above this blocks (R5)', ['velocity.burst_count', 'burst_count', 'velocity_block_count']],
  ['velocity_step_up_count', 3, 'velocity_10m from this value steps up (R7)', ['velocity_stepup_min', 'velocity_step_up_min', 'velocity.step_up_count', 'step_up_count', 'velocity_stepup_count', 'high_velocity_count']],
  ['velocity_step_up_max', 4, 'velocity_10m up to this value steps up (R7)', ['velocity_stepup_max', 'velocity_step_up_max']],
  ['amount_spike_multiplier', 5, 'Amount spike multiplier of avg_amount_30d (R8)', ['amount_spike.multiplier', 'spike_multiplier']],
  ['amount_spike_min_amount', 10000, 'Minimum amount for an amount spike (R8)', ['amount_spike.min_amount', 'spike_min_amount', 'amount_spike_minimum']],
  ['amount_spike_no_history_amount', 50000, 'Amount spike threshold when there is no 30-day history (R8)', ['amount_spike.no_history_amount', 'no_history_amount', 'amount_spike_no_history_min']],
  ['avg_amount_lookback_days', 30, 'Look-back for avg_amount_30d in days', ['avg_lookback_days', 'avg_amount_days', 'average_lookback_days']],
  ['impossible_travel_speed_kmph', 800, 'Speed above which travel is impossible (R6)', ['impossible_travel_kmph', 'impossible_travel.speed_kmph', 'max_speed_kmph', 'travel_speed_kmph']],
  ['impossible_travel_lookback_hours', 6, 'Look-back for the previous physical transaction (R6)', ['impossible_travel.lookback_hours', 'travel_lookback_hours']],
  ['odd_hour_start', 0, 'Odd-hours window start hour, IST (R11)', ['odd_hours.start', 'odd_hour.start']],
  ['odd_hour_end', 4, 'Odd-hours window end hour, IST, inclusive to hh:59 (R11)', ['odd_hours.end', 'odd_hour.end']],
  ['odd_hour_min_amount', 20000, 'Minimum amount in odd hours (R11)', ['odd_hours.min_amount', 'odd_hour.min_amount']],
  ['new_merchant_min_amount', 25000, 'Minimum ECOM amount at a new merchant (R12)', ['new_merchant.min_amount']],
  ['new_merchant_lookback_days', 90, 'Look-back for the new-merchant check in days (R12)', ['new_merchant.lookback_days']],
  ['high_risk_mcc_list', ['4829', '5967', '6051', '7995'], 'High-risk MCC list (R10)', ['high_risk_mccs', 'high_risk_mcc', 'mcc_high_risk_list']],
  ['multiple_red_flags_count', 3, 'Soft rules that together block (R13)', ['multiple_red_flags.count', 'red_flags_count', 'multiple_red_flags_min']],
  ['points', { R7: 25, R8: 30, R9: 25, R10: 15, R11: 15, R12: 20 }, 'Points per soft rule R7-R12', ['rule_points', 'soft_rule_points']],
  ['rule_risk_score_cap', 100, 'Cap of rule_risk_score', ['score_cap', 'max_rule_risk_score']],
  ['step_up_expiry_minutes', 15, 'Step-up expiry in minutes (FR-5)', ['step_up.expiry_minutes', 'stepup_expiry_minutes', 'step_up_timeout_minutes']],
  ['maker_checker_limit', 100000, 'FALSE_POSITIVE above this amount needs a manager (FR-7)', ['false_positive_manager_limit', 'maker_checker.limit', 'maker_checker_amount', 'false_positive_approval_limit']],
  ['sla_high_minutes', 30, 'SLA for HIGH alerts in minutes', ['sla_minutes.high', 'sla.high_minutes', 'sla.high']],
  ['sla_medium_minutes', 240, 'SLA for MEDIUM alerts in minutes', ['sla_minutes.medium', 'sla.medium_minutes', 'sla.medium']],
  ['alert_high_priority_amount', 50000, 'Alerts at or above this amount are HIGH priority', ['alert_high_amount', 'high_priority_amount', 'alert_priority_high_amount']],
  ['ai_step_up_threshold', 0.7, 'fraud_score that escalates APPROVE to STEP_UP (AI-2)', ['ai.step_up_threshold', 'ai_thresholds.step_up', 'model_step_up_threshold']],
  ['ai_block_threshold', 0.9, 'fraud_score that escalates STEP_UP to BLOCK (AI-2)', ['ai.block_threshold', 'ai_thresholds.block', 'model_block_threshold']],
  ['earth_radius_km', 6371, 'Earth radius for haversine distances (FR-3)', ['earth_radius']],
  // Operational parameters (not in the case-study table; documented in README)
  ['domestic_country', 'IN', 'Country code treated as domestic (R2)', []],
  ['model_timeout_ms', 150, 'Model call timeout; slower calls fall back to rules-only', []],
  ['ai_enabled', true, 'Kill switch for model scoring', []],
  ['otp_max_attempts', 3, 'Wrong OTP attempts allowed per step-up', []],
];

// Reason code of each soft rule, for points keyed by code.
const POINT_CODES = { HIGH_VELOCITY: 'R7', AMOUNT_SPIKE: 'R8', HIGH_RISK_GEO: 'R9', HIGH_RISK_MCC: 'R10', ODD_HOUR_HIGH_VALUE: 'R11', NEW_MERCHANT_HIGH_VALUE: 'R12' };

const DEFAULTS = Object.fromEntries(PARAMS.map(([k, v]) => [k, v]));
const DESCRIPTIONS = Object.fromEntries(PARAMS.map(([k, , d]) => [k, d]));

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    out[path.toLowerCase()] = v;
  }
  return out;
}

function findValue(flat, candidates) {
  for (const c of candidates) {
    const want = c.toLowerCase();
    const hit = Object.keys(flat).find((p) => p === want || p.endsWith('.' + want));
    if (hit !== undefined) return flat[hit];
  }
  return undefined;
}

// Map the supplied JSON onto our parameter keys. Returns { values, sources }.
function normaliseConfigJson(json) {
  const flat = flatten(json);
  const values = {};
  const sources = {};
  for (const [key, def, , aliases] of PARAMS) {
    let v = findValue(flat, [key, ...aliases]);
    if (key === 'points' && v === undefined) {
      // points may be stored per rule, e.g. { "R7": { "points": 25 } } or "r7_points": 25
      const perRule = {};
      for (const r of Object.keys(def)) {
        const pv = findValue(flat, [`${r}.points`, `${r}_points`, `points_${r}`]);
        if (pv !== undefined) perRule[r] = Number(pv);
      }
      if (Object.keys(perRule).length) v = { ...def, ...perRule };
    }
    if (v === undefined) {
      values[key] = def;
      sources[key] = 'default';
    } else {
      values[key] = coerce(key, v, def);
      sources[key] = 'file';
    }
  }
  return { values, sources };
}

function coerce(key, v, def) {
  if (Array.isArray(def)) return (Array.isArray(v) ? v : String(v).split(/[|,\s]+/)).map(String).filter(Boolean);
  if (typeof def === 'number') return Number(v);
  if (typeof def === 'boolean') return v === true || v === 'true' || v === 'Y' || v === 1;
  if (key === 'points') {
    // Points may be keyed by rule (R7) or by reason code (HIGH_VELOCITY), as in the official file.
    const out = { ...def };
    for (const [k, pv] of Object.entries(v)) out[POINT_CODES[k.toUpperCase()] || k.toUpperCase()] = Number(pv);
    return out;
  }
  return v;
}

function validateValue(key, value) {
  const def = DEFAULTS[key];
  if (def === undefined) return `unknown parameter ${key}`;
  if (Array.isArray(def)) return Array.isArray(value) && value.every((x) => /^\d{4}$/.test(String(x))) ? null : `${key} must be a list of 4-digit codes`;
  if (key === 'odd_hour_start' || key === 'odd_hour_end') return Number.isInteger(value) && value >= 0 && value <= 23 ? null : `${key} must be an hour from 0 to 23`;
  if (typeof def === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? null : `${key} must be a non-negative number`;
  if (typeof def === 'boolean') return typeof value === 'boolean' ? null : `${key} must be true or false`;
  if (key === 'points') {
    const ok = value && typeof value === 'object' && Object.keys(def).every((r) => typeof value[r] === 'number' && value[r] >= 0);
    return ok ? null : 'points must contain a number for each of R7-R12';
  }
  return typeof value === 'string' && value.length ? null : `${key} must be a non-empty string`;
}

// Load the current configuration (one small query; runs inside the authorisation transaction).
async function loadConfig(client) {
  const runner = client || { query };
  const { rows } = await runner.query('SELECT key, value FROM rule_config');
  const cfg = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS) cfg[r.key] = r.value;
  const v = await runner.query('SELECT COALESCE(MAX(version), 0) AS version FROM config_versions');
  cfg.version = Number(v.rows[0].version);
  return cfg;
}

module.exports = { PARAMS, DEFAULTS, DESCRIPTIONS, normaliseConfigJson, validateValue, loadConfig, flatten };
