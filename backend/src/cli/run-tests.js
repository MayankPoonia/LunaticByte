// CLI: run one or all test categories and print a summary.
//   node src/cli/run-tests.js          -> all categories
//   node src/cli/run-tests.js B E      -> rules engine and alerts
const { CATEGORIES, runCategory } = require('./testCategories');

(async () => {
  const wanted = process.argv.slice(2).map((s) => s.toUpperCase());
  const cats = wanted.length ? CATEGORIES.filter((c) => wanted.includes(c.id)) : CATEGORIES;
  let failed = 0;
  for (const cat of cats) {
    const r = await runCategory(cat.id);
    console.log(`\n${cat.id}. ${cat.name}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped (${r.duration_ms} ms)`);
    for (const t of r.tests) {
      console.log(`  [${t.status.toUpperCase()}] ${t.name}${t.skip_reason ? ` (${t.skip_reason})` : ''}`);
      if (t.error) console.log(`         ${t.error.split('\n').join('\n         ')}`);
    }
    if (r.failed || (r.exit_code && !r.tests.length)) {
      failed += r.failed || 1;
      if (!r.tests.length) console.log(r.stderr);
    }
  }
  console.log(failed ? `\n${failed} failure(s)` : '\nall selected categories passed');
  process.exit(failed ? 1 : 0);
})();
