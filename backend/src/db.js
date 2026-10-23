// PostgreSQL access: one shared pool plus a small transaction helper.
const { Pool, types } = require('pg');
const env = require('./env');

// Return NUMERIC as strings (exact decimals) and BIGINT as numbers.
types.setTypeParser(20, (v) => Number(v));
// DATE columns stay as 'YYYY-MM-DD' strings (no timezone shifting).
types.setTypeParser(1082, (v) => v);

let pool = new Pool({ connectionString: env.databaseUrl, max: Number(process.env.PG_POOL_MAX || 20) });

function getPool() {
  return pool;
}

// Used by tests to point the app at a different database.
function setPool(newPool) {
  pool = newPool;
}

function query(text, params) {
  return pool.query(text, params);
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTx, getPool, setPool };
