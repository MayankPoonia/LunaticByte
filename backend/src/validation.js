// Server-side validation of the transaction fields listed in case study section 4 (FR-2).
const { refs } = require('./data/refs');

const CHANNELS = ['POS', 'ECOM', 'ATM', 'CONTACTLESS'];
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?\+05:30$/;

class ValidationError extends Error {
  constructor(fields, status = 422) {
    super('Validation failed');
    this.status = status;
    this.fields = fields;
  }
}

// Returns a normalised transaction or throws ValidationError listing every invalid field.
function validateTransaction(body) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError([{ field: 'body', message: 'JSON object expected' }], 400);

  const { txn_id, card_id, txn_ts, amount, currency, merchant_id, mcc, channel, txn_city, txn_country } = body;

  if (typeof txn_id !== 'string' || !/^T[0-9]{9}$/.test(txn_id)) err('txn_id', 'must match ^T[0-9]{9}$');
  if (typeof card_id !== 'string' || !card_id.trim()) err('card_id', 'is required');

  let ts = null;
  if (typeof txn_ts !== 'string' || !TS_RE.test(txn_ts)) err('txn_ts', 'must be ISO-8601 with +05:30 offset, e.g. 2026-03-04T14:05:00+05:30');
  else {
    ts = Date.parse(txn_ts);
    if (Number.isNaN(ts)) err('txn_ts', 'is not a valid date-time');
  }

  const amountStr = typeof amount === 'number' ? String(amount) : amount;
  if (typeof amountStr !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amountStr)) err('amount', 'must be a positive number with at most 2 decimals');
  else if (Number(amountStr) <= 0 || Number(amountStr) > 1000000) err('amount', 'must be greater than 0 and at most 1000000.00');

  if (currency !== 'INR') err('currency', 'must be INR');
  if (typeof merchant_id !== 'string' || !refs.merchants.has(merchant_id)) err('merchant_id', 'unknown merchant');
  if (typeof mcc !== 'string' || !/^\d{4}$/.test(mcc)) err('mcc', 'must be a 4-digit string');
  if (!CHANNELS.includes(channel)) err('channel', `must be one of ${CHANNELS.join(', ')}`);

  const city = typeof txn_city === 'string' ? refs.cities.get(txn_city) : null;
  if (!city) err('txn_city', 'must exist in the cities reference data');
  if (typeof txn_country !== 'string' || !/^[A-Z]{2}$/.test(txn_country)) err('txn_country', 'must be a 2-letter country code');
  else if (city && city.country !== txn_country) err('txn_country', `must be ${city.country} for ${txn_city}`);

  if (errors.length) throw new ValidationError(errors);
  return {
    txn_id, card_id: card_id.trim(), txn_ts, ts, amount: Number(amountStr).toFixed(2), currency, merchant_id, mcc, channel, txn_city, txn_country,
  };
}

module.exports = { validateTransaction, ValidationError, CHANNELS };
