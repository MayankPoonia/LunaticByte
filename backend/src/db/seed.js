// Schema migration and deterministic seeding from the data pack.
// reset=true wipes all dynamic state (transactions, alerts, audit, outbox ...) and reloads the
// data pack so batch runs and demos start from the same "freshly loaded history".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../env');
const log = require('../logger');
const { withTx, query } = require('../db');
const { resolveDataDir, readCsv, findFile } = require('../data/dataDir');
const { normaliseConfigJson, DESCRIPTIONS } = require('../services/ruleConfig');

const SEED_LOCK = 724001; // pg advisory lock id shared by all backend replicas

const STAFF = [
  { user_id: 'U-ANALYST-1', username: 'analyst1', role: 'ANALYST', display_name: 'Asha Verma' },
  { user_id: 'U-ANALYST-2', username: 'analyst2', role: 'ANALYST', display_name: 'Ravi Menon' },
  { user_id: 'U-MANAGER-1', username: 'manager1', role: 'MANAGER', display_name: 'Neha Kapoor' },
  { user_id: 'U-MANAGER-2', username: 'manager2', role: 'MANAGER', display_name: 'Arjun Rao' },
];

async function migrate(client) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
}

function parseTs(value) {
  const s = String(value).trim().replace(' ', 'T');
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  const ms = Date.parse(hasZone ? s : `${s}+05:30`);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp ${value}`);
  return new Date(ms).toISOString();
}

const yn = (v) => ['Y', 'YES', 'TRUE', '1'].includes(String(v).trim().toUpperCase());
const hashCard = (number) => crypto.createHash('sha256').update(env.cardHashSalt + String(number)).digest('hex');

async function bulkInsert(client, table, columns, pgTypes, rows, chunk = 2000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const arrays = columns.map((_, c) => part.map((r) => r[c]));
    const params = columns.map((_, c) => `$${c + 1}::${pgTypes[c]}[]`).join(', ');
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) SELECT * FROM unnest(${params})`, arrays);
  }
}

const DYNAMIC_TABLES = ['outbox_events', 'notifications', 'model_feedback', 'audit_events', 'alerts', 'step_ups', 'transactions',
  'config_versions', 'rule_config', 'users', 'cards', 'customers', 'merchants', 'mcc_codes', 'country_risk', 'cities'];

async function seedAll({ reset = false } = {}) {
  const { dir } = resolveDataDir();
  const started = Date.now();
  return withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK]);
    await migrate(client);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM cards');
    if (rows[0].n > 0 && !reset) return { seeded: false, dir };

    await client.query(`TRUNCATE ${DYNAMIC_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query('ALTER SEQUENCE simulated_txn_seq RESTART WITH 700000001');
    const file = (name) => {
      const f = findFile(dir, name);
      if (!f) throw new Error(`missing data file case_01_${name}_*.csv in ${dir}`);
      return f;
    };

    const cities = readCsv(file('cities'));
    await bulkInsert(client, 'cities', ['city', 'country', 'lat', 'lon', 'city_tier'], ['text', 'text', 'float8', 'float8', 'text'],
      cities.map((r) => [r.city, r.country, Number(r.lat), Number(r.lon), r.city_tier]));

    const countries = readCsv(file('country_risk'));
    await bulkInsert(client, 'country_risk', ['country_code', 'country_name', 'risk_level'], ['text', 'text', 'text'],
      countries.map((r) => [r.country_code, r.country_name, String(r.risk_level).toUpperCase()]));

    const mccs = readCsv(file('mcc_codes'));
    await bulkInsert(client, 'mcc_codes', ['mcc', 'mcc_description', 'mcc_category', 'high_risk'], ['text', 'text', 'text', 'bool'],
      mccs.map((r) => [String(r.mcc), r.mcc_description, r.mcc_category, yn(r.high_risk)]));

    const merchants = readCsv(file('merchants'));
    await bulkInsert(client, 'merchants', ['merchant_id', 'merchant_name', 'mcc', 'mcc_description', 'city', 'country', 'merchant_risk'],
      ['text', 'text', 'text', 'text', 'text', 'text', 'text'],
      merchants.map((r) => [r.merchant_id, r.merchant_name, String(r.mcc), r.mcc_description, r.city, r.country, String(r.merchant_risk).toUpperCase()]));

    const customers = readCsv(file('customers'));
    await bulkInsert(client, 'customers', ['customer_id', 'full_name', 'mobile', 'email', 'city', 'username'],
      ['text', 'text', 'text', 'text', 'text', 'text'],
      customers.map((r) => [r.customer_id, r.full_name, r.mobile, r.email, r.city, r.username || null]));

    const cards = readCsv(file('cards'));
    await bulkInsert(client, 'cards', ['card_id', 'customer_id', 'card_hash', 'last4', 'card_type', 'card_status', 'issue_date',
      'expiry_date', 'home_city', 'home_country', 'daily_limit', 'international_enabled'],
    ['text', 'text', 'text', 'text', 'text', 'text', 'date', 'date', 'text', 'text', 'numeric', 'bool'],
    cards.map((r) => {
      const number = String(r.card_number || '').replace(/\D/g, '');
      return [r.card_id, r.customer_id, hashCard(number), number.slice(-4) || '0000', String(r.card_type).toUpperCase(),
        String(r.card_status).toUpperCase(), r.issue_date || null, r.expiry_date, r.home_city, r.home_country,
        r.daily_limit, yn(r.international_enabled)];
    }));

    const history = readCsv(file('transactions_history'));
    await bulkInsert(client, 'transactions', ['txn_id', 'card_id', 'txn_ts', 'amount', 'currency', 'merchant_id', 'mcc', 'channel',
      'txn_city', 'txn_country', 'source', 'status'],
    ['text', 'text', 'timestamptz', 'numeric', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
    history.map((r) => [r.txn_id, r.card_id, parseTs(r.txn_ts), r.amount, r.currency || 'INR', r.merchant_id, String(r.mcc),
      String(r.channel).toUpperCase(), r.txn_city, r.txn_country, 'HISTORY', String(r.status).toUpperCase()]));

    // Users: staff demo accounts plus one cardholder login per customer (same demo password).
    const hash = await bcrypt.hash(env.demoPassword, 10);
    const users = STAFF.map((s) => [s.user_id, s.username, hash, s.role, s.display_name, null]);
    for (const c of customers) {
      if (c.username) users.push([`U-${c.customer_id}`, c.username, hash, 'CARDHOLDER', c.full_name, c.customer_id]);
    }
    await bulkInsert(client, 'users', ['user_id', 'username', 'password_hash', 'role', 'display_name', 'customer_id'],
      ['text', 'text', 'text', 'text', 'text', 'text'], users);

    // Rule configuration from the JSON file (FR-4).
    const cfgFile = findFile(dir, 'rules_config');
    const json = cfgFile ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
    const { values, sources } = normaliseConfigJson(json);
    await bulkInsert(client, 'rule_config', ['key', 'value', 'source', 'description', 'updated_by'], ['text', 'jsonb', 'text', 'text', 'text'],
      Object.keys(values).map((k) => [k, JSON.stringify(values[k]), sources[k], DESCRIPTIONS[k], 'seed']));
    await client.query('INSERT INTO config_versions (changed_by, snapshot) VALUES ($1, $2)', ['seed', JSON.stringify({ values, source_file: cfgFile && path.basename(cfgFile), raw: json })]);
    await client.query(`INSERT INTO audit_events (entity, entity_id, actor, role, action, comment, details)
      VALUES ('CONFIG', 'rule_config', 'system', 'SYSTEM', 'CONFIG_LOADED', $1, $2)`,
    [`Loaded from ${cfgFile ? path.basename(cfgFile) : 'defaults'}`, JSON.stringify({ values, sources })]);

    const fromDefault = Object.keys(sources).filter((k) => sources[k] === 'default');
    const summary = {
      seeded: true, dir, ms: Date.now() - started,
      counts: { cities: cities.length, merchants: merchants.length, customers: customers.length, cards: cards.length, history: history.length },
      config_defaults_used: fromDefault,
    };
    log.info('seed complete', summary);
    return summary;
  });
}

async function ensureSchema() {
  await withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK]);
    await migrate(client);
  });
}

module.exports = { seedAll, migrate, ensureSchema, parseTs, bulkInsert, hashCard, STAFF, query };
