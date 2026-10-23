// Test runner: runs the backend test categories (node:test) on the server against a separate test
// database, so the live demo data is never touched.
import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { useApi } from '../lib/session';
import { Badge, ErrorBanner, Loading, PageHeader, Section } from '../components/ui';

export default function TestRunner() {
  const cats = useApi('/test-runner/categories');
  const [results, setResults] = useState({});
  const [running, setRunning] = useState(null);
  const [error, setError] = useState('');

  async function run(id) {
    setRunning(id);
    setError('');
    try {
      const { data } = await api('/test-runner/run', { method: 'POST', body: { category: id } });
      setResults((r) => ({ ...r, [id]: data }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRunning(null);
    }
  }

  async function runAll() {
    for (const c of cats.data.categories) await run(c.id); // eslint-disable-line no-await-in-loop
  }

  if (!cats.data) return <div><PageHeader title="Test runner" /><ErrorBanner error={cats.error} />{!cats.error && <Loading />}</div>;
  const total = Object.values(results).reduce((a, r) => ({ p: a.p + r.passed, f: a.f + r.failed, s: a.s + r.skipped }), { p: 0, f: 0, s: 0 });

  return (
    <div>
      <PageHeader title="Test runner" subtitle="Automated test categories run on the server against an isolated test database with deterministic fixtures."
        actions={<button type="button" className="btn-primary" onClick={runAll} disabled={!!running || !cats.data.enabled}>Run all categories</button>} />
      <ErrorBanner error={error} />
      {!cats.data.enabled && <ErrorBanner error="The test runner is disabled on this server (ENABLE_TEST_RUNNER=false)." />}
      {Object.keys(results).length > 0 && (
        <p className="mb-4 text-sm text-slate-600">{total.p} passed, {total.f} failed, {total.s} skipped across {Object.keys(results).length} categories.</p>
      )}
      <div className="space-y-4">
        {cats.data.categories.map((c) => {
          const r = results[c.id];
          return (
            <Section key={c.id} title={`${c.id}. ${c.name}`}
              actions={(
                <div className="flex items-center gap-3">
                  {r && <span className="text-sm text-slate-600">{r.passed} passed, {r.failed} failed, {r.skipped} skipped in {(r.duration_ms / 1000).toFixed(1)} s</span>}
                  <button type="button" className="btn-secondary btn-sm" onClick={() => run(c.id)} disabled={!!running || !cats.data.enabled}>{running === c.id ? 'Running' : 'Run'}</button>
                </div>
              )}>
              {!r ? <p className="muted">{running === c.id ? 'Running tests...' : `Not run yet. File: ${c.file}`}</p> : (
                <ul className="divide-y divide-slate-100">
                  {r.tests.map((t) => (
                    <li key={t.name} className="py-2">
                      <div className="flex items-start justify-between gap-4 text-sm">
                        <span className="text-slate-800">{t.name}</span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="text-xs text-slate-500">{t.duration_ms} ms</span>
                          <Badge tone={t.status === 'pass' ? 'green' : t.status === 'fail' ? 'red' : 'gray'}>{t.status.toUpperCase()}</Badge>
                        </span>
                      </div>
                      {t.skip_reason && <p className="mt-1 text-xs text-slate-500">{t.skip_reason}</p>}
                      {t.error && <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-800">{t.error}</pre>}
                    </li>
                  ))}
                  {!r.tests.length && <li className="py-2"><pre className="whitespace-pre-wrap text-xs text-red-800">{r.stderr || 'No test results were reported.'}</pre></li>}
                </ul>
              )}
            </Section>
          );
        })}
      </div>
    </div>
  );
}
