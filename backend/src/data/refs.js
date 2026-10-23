// Reference data (cities, country risk, MCC codes, merchants) is small and read-only during
// processing, so it is cached in memory and reloaded after a seed/reset.
const { query } = require('../db');

const refs = {
  cities: new Map(),
  countryRisk: new Map(),
  mcc: new Map(),
  merchants: new Map(),
  loadedAt: null,
};

async function loadRefs() {
  const [cities, countries, mccs, merchants] = await Promise.all([
    query('SELECT city, country, lat, lon, city_tier FROM cities'),
    query('SELECT country_code, risk_level FROM country_risk'),
    query('SELECT mcc, mcc_description, mcc_category, high_risk FROM mcc_codes'),
    query('SELECT merchant_id, merchant_name, mcc, city, country, merchant_risk FROM merchants'),
  ]);
  refs.cities = new Map(cities.rows.map((r) => [r.city, r]));
  refs.countryRisk = new Map(countries.rows.map((r) => [r.country_code, r.risk_level]));
  refs.mcc = new Map(mccs.rows.map((r) => [r.mcc, r]));
  refs.merchants = new Map(merchants.rows.map((r) => [r.merchant_id, r]));
  refs.loadedAt = new Date();
  return refs;
}

module.exports = { refs, loadRefs };
