// node:test reporter that prints one JSON line per finished test (used by the Test Runner page).
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    if (d.details && d.details.type === 'suite') continue;
    const skipped = d.skip !== undefined && d.skip !== false;
    const line = {
      name: d.name,
      status: skipped ? 'skip' : event.type === 'test:pass' ? 'pass' : 'fail',
      duration_ms: Math.round((d.details && d.details.duration_ms) || 0),
      skip_reason: typeof d.skip === 'string' ? d.skip : undefined,
      error: event.type === 'test:fail' ? String((d.details.error && (d.details.error.cause || d.details.error).message) || d.details.error).slice(0, 1500) : undefined,
    };
    yield JSON.stringify(line) + '\n';
  }
}
