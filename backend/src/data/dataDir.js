// Locates the case-study data pack in ./data (or DATA_DIR). Files are discovered by name pattern
// (case_01_<name>_*.csv) so version suffixes may differ.
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const env = require('../env');

const NAMES = [
  'customers', 'cards', 'merchants', 'mcc_codes', 'cities', 'country_risk', 'rules_config',
  'transactions_history', 'batch_transactions_sample', 'batch_sample_expected_alerts', 'batch_transactions_eval',
  'labelled_transactions',
];

function findFile(dir, name) {
  if (!dir || !fs.existsSync(dir)) return null;
  const re = new RegExp(`^case_01_${name}(_V[\\d.]+)?\\.(csv|json)$`, 'i');
  const hit = fs.readdirSync(dir).find((f) => re.test(f));
  return hit ? path.join(dir, hit) : null;
}

function resolveDataDir() {
  const dir = env.dataDir || path.join(env.repoRoot, 'data');
  if (!findFile(dir, 'cards') || !findFile(dir, 'cities')) {
    throw new Error(`No data pack found in ${dir}. Copy the case-study files (case_01_*.csv, case_01_rules_config_*.json) into it.`);
  }
  return { dir };
}

function readCsv(file) {
  // Merchant names are untrusted text: a real CSV parser handles quotes and embedded commas safely.
  return parse(fs.readFileSync(file), { columns: (h) => h.map((c) => c.trim().replace(/^﻿/, '')), skip_empty_lines: true, trim: true });
}

function dataFile(name, dir) {
  return findFile(dir || resolveDataDir().dir, name);
}

module.exports = { resolveDataDir, readCsv, dataFile, findFile, NAMES };
