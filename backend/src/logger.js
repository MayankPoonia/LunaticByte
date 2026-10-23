// Minimal structured logger. Never pass full card numbers, OTP secrets of real systems or passwords here.
const env = require('./env');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[env.logLevel] || 20;

function log(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, instance: env.instanceId, msg, ...(fields || {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

module.exports = {
  debug: (m, f) => log('debug', m, f),
  info: (m, f) => log('info', m, f),
  warn: (m, f) => log('warn', m, f),
  error: (m, f) => log('error', m, f),
};
