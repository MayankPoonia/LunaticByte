// Seed or reset the database from the data pack.
//   node src/cli/seed.js           -> seed only if empty
//   node src/cli/seed.js --reset   -> wipe all transactions/alerts/audit and reload the data pack
const { seedAll } = require('../db/seed');
const { getPool } = require('../db');

(async () => {
  const reset = process.argv.includes('--reset');
  const summary = await seedAll({ reset });
  console.log(JSON.stringify(summary, null, 2));
  await getPool().end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
