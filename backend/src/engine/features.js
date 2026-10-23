// Derived card-profile features (case study 6.1 "Definitions" and 6.1.2 "Model features").
// Pure function: the caller supplies the card's prior transactions, so the same code serves
// the live API, the batch command and the unit tests.
const { haversineKm } = require('./geo');
const { MINUTE, HOUR, DAY, istDate, istHour, daysBetween } = require('./time');

const PHYSICAL_CHANNELS = new Set(['POS', 'ATM', 'CONTACTLESS']);

const toPaise = (amount) => Math.round(Number(amount) * 100);

/**
 * @param txn    { ts (epoch ms), amount, merchant_id, mcc, channel, txn_city, txn_country }
 * @param card   { home_city, home_country, issue_date, card_type }
 * @param priors prior transactions of the same card: { ts, amount, status, merchant_id, channel, txn_city }.
 *               Only rows with ts strictly earlier than txn.ts are used.
 * @param refs   reference data (cities, countryRisk, mcc, merchants maps)
 * @param cfg    normalised rule configuration
 */
function computeFeatures(txn, card, priors, refs, cfg) {
  const t = txn.ts;
  const earlier = priors.filter((p) => p.ts < t);
  const approved = earlier.filter((p) => p.status === 'APPROVED');

  // velocity_10m: prior transactions (any decision) within the window before the current one
  const velocityFrom = t - cfg.velocity_window_minutes * MINUTE;
  const velocity_10m = earlier.filter((p) => p.ts >= velocityFrom).length;
  const velocity_24h = earlier.filter((p) => p.ts >= t - DAY).length;

  // approved_today: sum of prior APPROVED amounts on the same IST calendar date
  const today = istDate(t);
  const approvedTodayPaise = approved.filter((p) => istDate(p.ts) === today).reduce((s, p) => s + toPaise(p.amount), 0);

  // avg_amount_30d: mean of prior APPROVED amounts in the look-back window; null when none
  const avgFrom = t - cfg.avg_amount_lookback_days * DAY;
  const last30 = approved.filter((p) => p.ts >= avgFrom);
  const sum30Paise = last30.reduce((s, p) => s + toPaise(p.amount), 0);
  const avg_amount_30d = last30.length ? sum30Paise / last30.length / 100 : null;
  // For output: round half up from the exact paise sum (binary floats would turn 3756.615 into 3756.61).
  const avg_amount_30d_2dp = last30.length ? Math.round(sum30Paise / last30.length) / 100 : null;

  // speed_kmph: only for a physical transaction with a prior APPROVED physical one in the look-back window
  let speed_kmph = null;
  let speed_reference = null;
  if (PHYSICAL_CHANNELS.has(txn.channel)) {
    const from = t - cfg.impossible_travel_lookback_hours * HOUR;
    const candidates = approved.filter((p) => PHYSICAL_CHANNELS.has(p.channel) && p.ts >= from);
    const last = candidates.reduce((a, b) => (!a || b.ts > a.ts ? b : a), null);
    const c1 = last && refs.cities.get(last.txn_city);
    const c2 = refs.cities.get(txn.txn_city);
    if (last && c1 && c2) {
      const distance = haversineKm(c1.lat, c1.lon, c2.lat, c2.lon, cfg.earth_radius_km);
      const hours = (t - last.ts) / HOUR;
      if (distance === 0) speed_kmph = 0;
      else if (hours === 0) speed_kmph = 99999.99;
      else speed_kmph = distance / hours;
      speed_reference = { txn_city: last.txn_city, minutes_ago: Math.round((t - last.ts) / MINUTE), distance_km: distance };
    }
  }

  // new merchant: no prior transaction (any status) with this merchant in the look-back window
  const merchantFrom = t - cfg.new_merchant_lookback_days * DAY;
  const new_merchant = !earlier.some((p) => p.merchant_id === txn.merchant_id && p.ts >= merchantFrom);

  // model features (6.1.2), same meaning as the labelled training file
  const home = refs.cities.get(card.home_city);
  const here = refs.cities.get(txn.txn_city);
  const merchant = refs.merchants.get(txn.merchant_id);
  const mccInfo = refs.mcc.get(String(txn.mcc));
  const amount = Number(txn.amount);
  const model = {
    card_type: card.card_type,
    channel: txn.channel,
    mcc: String(txn.mcc),
    mcc_category: mccInfo ? mccInfo.mcc_category : null,
    merchant_risk: merchant ? merchant.merchant_risk : null,
    amount,
    local_hour: istHour(t),
    is_international: txn.txn_country !== card.home_country ? 1 : 0,
    country_risk_high: refs.countryRisk.get(txn.txn_country) === 'HIGH' ? 1 : 0,
    distance_from_home_km: home && here ? haversineKm(home.lat, home.lon, here.lat, here.lon, cfg.earth_radius_km) : null,
    velocity_10m,
    velocity_24h,
    amount_to_avg30_ratio: avg_amount_30d ? amount / avg_amount_30d : null,
    new_merchant_flag: new_merchant ? 1 : 0,
    card_age_days: card.issue_date ? daysBetween(card.issue_date, istDate(t)) : null,
  };

  return {
    velocity_10m,
    velocity_24h,
    approved_today: approvedTodayPaise / 100,
    avg_amount_30d,
    avg_amount_30d_2dp,
    speed_kmph,
    speed_reference,
    new_merchant,
    txn_date: today,
    model,
  };
}

module.exports = { computeFeatures, PHYSICAL_CHANNELS, toPaise };
