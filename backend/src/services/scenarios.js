// Predefined demo scenarios for the simulator. Wherever possible a scenario replays a row of the
// sample batch file (worked examples 1-10) with a fresh txn_id, so the decision comes from the real
// engine and real history, not from anything hard-coded here.
const { readCsv, dataFile } = require('../data/dataDir');
const { refs } = require('../data/refs');
const { query } = require('../db');

const FIELDS = ['card_id', 'txn_ts', 'amount', 'currency', 'merchant_id', 'mcc', 'channel', 'txn_city', 'txn_country'];

function sampleRows() {
  try {
    const f = dataFile('batch_transactions_sample');
    return f ? readCsv(f) : [];
  } catch {
    return [];
  }
}

function fromSample(rows, txnId) {
  const r = rows.find((x) => x.txn_id === txnId);
  if (!r) return null;
  return Object.fromEntries(FIELDS.map((k) => [k, r[k]]));
}

async function listScenarios() {
  const rows = sampleRows();
  const out = [];
  const add = (s) => s.payload && out.push(s);

  add({ id: 'normal', title: 'Normal purchase', expected: 'APPROVE',
    description: 'Worked example 1: a small POS purchase at a known merchant in the home city.', payload: fromSample(rows, 'T200000001') });
  add({ id: 'card-blocked', title: 'Policy decline: card not active', expected: 'BLOCK (CARD_NOT_ACTIVE), no alert',
    description: 'Worked example 2: hard stop R1. Policy declines do not create fraud alerts.', payload: fromSample(rows, 'T200000002') });
  add({ id: 'impossible-travel', title: 'Impossible travel', expected: 'BLOCK (IMPOSSIBLE_TRAVEL), HIGH alert',
    description: 'Worked example 5: Delhi POS one hour after a Mumbai POS purchase (1148 km/h).', payload: fromSample(rows, 'T200000005') });
  add({ id: 'step-up', title: 'Amount spike needs step-up', expected: 'STEP_UP (AMOUNT_SPIKE)',
    description: 'Worked example 7: INR 15,000 against a 30-day average of INR 2,400. Confirm or deny on the cardholder screen.', payload: fromSample(rows, 'T200000007') });
  add({ id: 'red-flags', title: 'Multiple red flags', expected: 'BLOCK (... MULTIPLE_RED_FLAGS), HIGH alert',
    description: 'Worked example 10: late-night crypto purchase at a new merchant.', payload: fromSample(rows, 'T200000010') });

  const base = fromSample(rows, 'T200000001');
  if (base) {
    out.push({ id: 'velocity', title: 'Velocity burst (send 6 sequentially)', expected: 'APPROVE x3, STEP_UP x2, then BLOCK (VELOCITY_BURST)',
      description: 'Same card, current time, sent one after another. velocity_10m counts the earlier ones.', payload: { ...base, txn_ts: 'now' }, repeat: 6 });
  }
  // Maker-checker demo: a BLOCKED transaction above INR 1,00,000 at a blacklisted merchant (R3 creates an alert).
  const blacklisted = (await query("SELECT merchant_id, mcc, city, country FROM merchants WHERE merchant_risk = 'BLACKLISTED' AND country = 'IN' ORDER BY merchant_id LIMIT 1")).rows[0];
  // A card not used by the other scenarios, active, with a daily limit above the amount (so only R3 fires).
  const card = (await query(
    `SELECT card_id FROM cards WHERE card_status = 'ACTIVE' AND expiry_date > now() AND daily_limit >= 120000 AND home_country = 'IN'
       AND card_id NOT BETWEEN 'C1001' AND 'C1010' ORDER BY card_id LIMIT 1`)).rows[0];
  if (blacklisted && card && refs.cities.has(blacklisted.city)) {
    out.push({ id: 'high-value-alert', title: 'High-value alert for maker-checker', expected: 'BLOCK (MERCHANT_BLACKLISTED), HIGH alert above INR 1,00,000',
      description: 'Creates an alert on an INR 1,20,000 transaction. Closing it as FALSE_POSITIVE needs a manager (worked example 12).',
      payload: { card_id: card.card_id, txn_ts: 'now', amount: '120000.00', currency: 'INR', merchant_id: blacklisted.merchant_id, mcc: blacklisted.mcc,
        channel: 'ECOM', txn_city: blacklisted.city, txn_country: blacklisted.country } });
  }
  return out;
}

module.exports = { listScenarios };
