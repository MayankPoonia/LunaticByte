// Transaction simulator: acts as the simulated card gateway. Every request goes through the real
// backend authorisation service. Sequential mode waits for each response before sending the next.
// Round-trip latency is measured in the browser with performance.now(); server processing time and
// model latency come from the API response and are shown separately.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useSession } from '../lib/session';
import { money, num } from '../lib/format';
import { DecisionBadge, ErrorBanner, ModelBadge, Notice, PageHeader, ReasonCodes, ScoreValue, Section, StatusBadge, TableWrap } from '../components/ui';

const EMPTY = { card_id: '', merchant_id: '', amount: '3500.00', currency: 'INR', mcc: '', channel: 'POS', txn_city: '', txn_country: '' };

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function shiftIso(iso, seconds) {
  const ms = Date.parse(iso) + seconds * 1000 + 330 * 60000;
  return `${new Date(ms).toISOString().slice(0, 19)}+05:30`;
}

// Live elapsed-time display while a request is in flight.
function useTimer() {
  const [elapsed, setElapsed] = useState(null);
  const start = useRef(null);
  const frame = useRef(null);
  const tick = () => {
    setElapsed(performance.now() - start.current);
    frame.current = requestAnimationFrame(tick);
  };
  return {
    elapsed,
    begin() {
      start.current = performance.now();
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(tick);
      return start.current;
    },
    end() {
      cancelAnimationFrame(frame.current);
      const total = performance.now() - start.current;
      setElapsed(total);
      return total;
    },
  };
}

export default function Simulator() {
  const { user } = useSession();
  const [options, setOptions] = useState(null);
  const [scenarios, setScenarios] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [tsMode, setTsMode] = useState('now');
  const [customTs, setCustomTs] = useState('2026-03-04T14:05:00+05:30');
  const [stepSeconds, setStepSeconds] = useState(60);
  const [idMode, setIdMode] = useState('auto');
  const [customId, setCustomId] = useState('');
  const [count, setCount] = useState(6);
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState('');
  const [scenarioNote, setScenarioNote] = useState(null);
  const stopRef = useRef(false);
  const timer = useTimer();
  const counter = useRef(0);

  useEffect(() => {
    Promise.all([api('/simulator/options'), api('/simulator/scenarios')]).then(([o, s]) => {
      setOptions(o.data);
      setScenarios(s.data.scenarios);
      const card = o.data.cards[0];
      const m = o.data.merchants.find((x) => x.merchant_id === 'M00450') || o.data.merchants[0];
      setForm((f) => ({ ...f, card_id: card ? card.card_id : '', merchant_id: m.merchant_id, mcc: m.mcc, txn_city: m.city, txn_country: m.country }));
    }).catch((err) => setError(errorText(err)));
  }, []);

  const merchant = useMemo(() => options && options.merchants.find((m) => m.merchant_id === form.merchant_id), [options, form.merchant_id]);
  const card = useMemo(() => options && options.cards.find((c) => c.card_id === form.card_id), [options, form.card_id]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function chooseMerchant(id) {
    const m = options.merchants.find((x) => x.merchant_id === id);
    setForm((f) => ({ ...f, merchant_id: id, mcc: m.mcc, txn_city: m.city, txn_country: m.country }));
  }

  function chooseCity(city) {
    const c = options.cities.find((x) => x.city === city);
    setForm((f) => ({ ...f, txn_city: city, txn_country: c ? c.country : f.txn_country }));
  }

  function loadScenario(s) {
    const { txn_ts: ts, ...rest } = s.payload;
    setForm({ ...EMPTY, ...rest });
    if (ts === 'now') setTsMode('now');
    else {
      setTsMode('custom');
      setCustomTs(ts);
    }
    setIdMode('auto');
    setCount(s.repeat || 1);
    setScenarioNote(s);
  }

  async function sendOne(body, label) {
    counter.current += 1;
    const n = counter.current;
    setInFlight(true);
    let row;
    if (!body.txn_id) {
      // Reserve the id first (not timed), so a retry of this row resends the same txn_id.
      try {
        body = { ...body, txn_id: (await api('/simulator/next-id')).data.txn_id };
      } catch (err) {
        setInFlight(false);
        setResults((r) => [{ n, ok: false, http: err.status || 'network', error: errorText(err), retryable: true, body, label, roundTrip: 0 }, ...r]);
        return null;
      }
    }
    timer.begin();
    try {
      const { data, status, headers } = await api('/simulator/transactions', { method: 'POST', body });
      row = { n, ok: true, http: status, data, label, servedBy: headers.get('x-served-by') };
    } catch (err) {
      row = { n, ok: false, http: err.status || 'network', error: errorText(err), retryable: !err.status || err.status >= 500, body, label };
    }
    row.roundTrip = timer.end();
    setInFlight(false);
    setResults((r) => [row, ...r].slice(0, 200));
    return row;
  }

  function buildBody(i = 0) {
    const body = { ...form };
    body.txn_ts = tsMode === 'now' ? 'now' : shiftIso(customTs, i * Number(stepSeconds || 0));
    if (idMode === 'custom') body.txn_id = customId.trim();
    return body;
  }

  async function sendSingle() {
    setError('');
    await sendOne(buildBody(0), scenarioNote ? scenarioNote.title : 'Single');
  }

  async function sendSequential() {
    setError('');
    const n = Math.max(1, Math.min(Number(count) || 1, options.batch_limit));
    stopRef.current = false;
    setRunning(true);
    for (let i = 0; i < n && !stopRef.current; i++) {
      // Sequential: the next request is only sent after this one has returned.
      await sendOne(buildBody(i), `Sequence ${i + 1}/${n}`);
    }
    setRunning(false);
  }

  async function resetDemo() {
    const typed = window.prompt('This reloads the data pack and deletes all simulated transactions, alerts and audit entries. Type RESET to continue.');
    if (typed !== 'RESET') return;
    try {
      await api('/demo/reset', { method: 'POST', body: { confirm: 'RESET' } });
      setResults([]);
      window.location.reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const okRows = results.filter((r) => r.ok);
  const trips = results.map((r) => r.roundTrip);
  const summary = {
    sent: results.length, ok: okRows.length, failed: results.length - okRows.length,
    avg: trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null, p95: percentile(trips, 95),
    server: okRows.length ? okRows.reduce((a, r) => a + Number(r.data.processing_ms || 0), 0) / okRows.length : null,
  };

  if (!options) return <div><PageHeader title="Transaction simulator" /><ErrorBanner error={error} />{!error && <p className="muted">Loading reference data...</p>}</div>;

  return (
    <div>
      <PageHeader
        title="Transaction simulator"
        subtitle="Send synthetic transactions through the real authorisation service. Decisions, rules and scores come from the backend."
        actions={user.role === 'MANAGER' && <button type="button" className="btn-secondary" onClick={resetDemo}>Reset demo data</button>}
      />
      <ErrorBanner error={error} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Scenarios" className="lg:col-span-1">
          <ul className="space-y-3">
            {scenarios.map((s) => (
              <li key={s.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{s.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">Expected: {s.expected}</div>
                  </div>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => loadScenario(s)}>Load</button>
                </div>
              </li>
            ))}
            {!scenarios.length && <li className="muted">No scenarios available for this data pack.</li>}
          </ul>
          <p className="mt-4 text-xs text-slate-500">
            Model outage demo: stop the model service (<span className="mono">docker compose stop ml</span>) and send any transaction. The
            rules-only decision is returned with model status MODEL_UNAVAILABLE.
          </p>
        </Section>

        <Section title="Transaction" className="lg:col-span-2">
          {scenarioNote && <Notice>{scenarioNote.title}: {scenarioNote.description}</Notice>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="card">Card</label>
              <select id="card" className="input" value={form.card_id} onChange={set('card_id')}>
                {options.cards.map((c) => <option key={c.card_id} value={c.card_id}>{c.card_id} - {c.masked} - {c.card_status} - {c.home_city}</option>)}
              </select>
              {card && <p className="mt-1 text-xs text-slate-500">Daily limit {money(card.daily_limit)}; international {card.international_enabled ? 'enabled' : 'not enabled'}</p>}
            </div>
            <div>
              <label className="label" htmlFor="merchant">Merchant</label>
              <select id="merchant" className="input" value={form.merchant_id} onChange={(e) => chooseMerchant(e.target.value)}>
                {options.merchants.map((m) => <option key={m.merchant_id} value={m.merchant_id}>{m.merchant_id} - {m.merchant_name} ({m.city}, {m.merchant_risk})</option>)}
              </select>
              {merchant && <p className="mt-1 text-xs text-slate-500">MCC {merchant.mcc}; risk {merchant.merchant_risk}</p>}
            </div>
            <div>
              <label className="label" htmlFor="amount">Amount (INR)</label>
              <input id="amount" className="input" inputMode="decimal" value={form.amount} onChange={set('amount')} />
            </div>
            <div>
              <label className="label" htmlFor="channel">Channel</label>
              <select id="channel" className="input" value={form.channel} onChange={set('channel')}>
                {options.channels.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="city">Transaction city</label>
              <select id="city" className="input" value={form.txn_city} onChange={(e) => chooseCity(e.target.value)}>
                {options.cities.map((c) => <option key={c.city} value={c.city}>{c.city} ({c.country})</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label" htmlFor="country">Country</label>
                <input id="country" className="input" value={form.txn_country} onChange={set('txn_country')} />
              </div>
              <div>
                <label className="label" htmlFor="mcc">MCC</label>
                <input id="mcc" className="input" value={form.mcc} onChange={set('mcc')} />
              </div>
            </div>
            <fieldset>
              <legend className="label">Timestamp (IST)</legend>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="radio" checked={tsMode === 'now'} onChange={() => setTsMode('now')} /> Current time</label>
                <label className="flex items-center gap-2"><input type="radio" checked={tsMode === 'custom'} onChange={() => setTsMode('custom')} /> Fixed</label>
              </div>
              {tsMode === 'custom' && (
                <div className="mt-2 space-y-2">
                  <input aria-label="Fixed timestamp" className="input" value={customTs} onChange={(e) => setCustomTs(e.target.value)} />
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    In a sequence, add
                    <input aria-label="Seconds between transactions" className="input w-20 py-1" value={stepSeconds} onChange={(e) => setStepSeconds(e.target.value)} />
                    seconds per transaction
                  </label>
                </div>
              )}
            </fieldset>
            <fieldset>
              <legend className="label">Transaction ID</legend>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="radio" checked={idMode === 'auto'} onChange={() => setIdMode('auto')} /> New ID per transaction</label>
                <label className="flex items-center gap-2"><input type="radio" checked={idMode === 'custom'} onChange={() => setIdMode('custom')} /> Fixed</label>
              </div>
              {idMode === 'custom' && <input aria-label="Fixed transaction id" className="input mt-2" placeholder="T123456789" value={customId} onChange={(e) => setCustomId(e.target.value)} />}
              {idMode === 'custom' && <p className="mt-1 text-xs text-slate-500">Sending a fixed ID twice demonstrates idempotency: the original decision is returned.</p>}
            </fieldset>
          </div>

          <div className="mt-6 flex flex-wrap items-end gap-4 border-t border-slate-200 pt-5">
            <button type="button" className="btn-primary" onClick={sendSingle} disabled={running || inFlight}>Send transaction</button>
            <div>
              <label className="label" htmlFor="count">Number of transactions (max {options.batch_limit})</label>
              <input id="count" type="number" min="1" max={options.batch_limit} className="input w-28" value={count} onChange={(e) => setCount(e.target.value)} />
            </div>
            {!running
              ? <button type="button" className="btn-secondary" onClick={sendSequential} disabled={inFlight}>Send {Math.max(1, Math.min(Number(count) || 1, options.batch_limit))} sequentially</button>
              : <button type="button" className="btn-danger" onClick={() => { stopRef.current = true; }}>Stop sequence</button>}
            <div className="ml-auto text-right" aria-live="polite">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{inFlight ? 'Waiting for response' : 'Last round trip'}</div>
              <div className={`font-mono text-2xl font-semibold ${inFlight ? 'text-amber-700' : 'text-slate-900'}`}>{timer.elapsed === null ? '-' : `${timer.elapsed.toFixed(0)} ms`}</div>
              <div className="text-xs text-slate-500">SLA: 300 ms with model, 150 ms rules-only (server p95)</div>
            </div>
          </div>
        </Section>
      </div>

      <Section className="mt-6" title="Results"
        actions={<button type="button" className="btn-secondary btn-sm" onClick={() => setResults([])} disabled={!results.length}>Clear results</button>}>
        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-6">
          {[['Sent', summary.sent], ['Succeeded', summary.ok], ['Failed', summary.failed], ['Avg round trip', summary.avg === null ? '-' : `${summary.avg.toFixed(0)} ms`],
            ['p95 round trip', summary.p95 === null ? '-' : `${summary.p95.toFixed(0)} ms`], ['Avg server time', summary.server === null ? '-' : `${summary.server.toFixed(1)} ms`]].map(([k, v]) => (
            <div key={k}>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</div>
              <div className="mt-1 text-lg font-semibold">{v}</div>
            </div>
          ))}
        </div>
        {results.length === 0 ? <p className="muted">Send a transaction or load a scenario to see decisions here.</p> : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>#</th><th>Transaction</th><th>Request</th><th>Decision</th><th>Status</th><th>Reason codes</th><th>Rule score</th><th>Fraud score</th><th>Model</th><th>velocity_10m</th><th>Server</th><th>Round trip</th><th /></tr></thead>
              <tbody>
                {results.map((r) => (r.ok ? (
                  <tr key={r.n}>
                    <td>{r.n}</td>
                    <td><Link className="mono text-brand-700 hover:underline" to={`/transactions/${r.data.txn_id}`}>{r.data.txn_id}</Link><div className="text-xs text-slate-500">{r.label}</div></td>
                    <td><span className="text-xs">HTTP {r.http}{r.data.duplicate ? ' (replay)' : ''}</span>{r.servedBy && <div className="mono text-slate-400" title="Backend replica that served this request">{r.servedBy.slice(0, 12)}</div>}</td>
                    <td><DecisionBadge value={r.data.decision} />{r.data.rules_decision !== r.data.decision && <div className="text-xs text-slate-500">rules: {r.data.rules_decision}</div>}</td>
                    <td><StatusBadge value={r.data.status} /></td>
                    <td className="whitespace-normal"><ReasonCodes codes={r.data.reason_codes} /></td>
                    <td>{r.data.rule_risk_score ?? '-'}</td>
                    <td><ScoreValue score={r.data.fraud_score} /></td>
                    <td><ModelBadge status={r.data.model_status} /></td>
                    <td>{r.data.features ? r.data.features.velocity_10m : '-'}</td>
                    <td>{num(r.data.processing_ms, 1)} ms{r.data.model_latency_ms !== null && <div className="text-xs text-slate-500">model {num(r.data.model_latency_ms, 1)} ms</div>}</td>
                    <td className="font-mono">{r.roundTrip.toFixed(0)} ms</td>
                    <td>{r.data.alert_id && <Link className="text-xs text-brand-700 hover:underline" to={`/alerts/${r.data.alert_id}`}>Alert {r.data.alert_id}</Link>}</td>
                  </tr>
                ) : (
                  <tr key={r.n} className="bg-red-50/50">
                    <td>{r.n}</td>
                    <td colSpan={3}><span className="text-sm font-medium text-red-800">Request failed (HTTP {r.http})</span><div className="text-xs text-slate-500">{r.label}</div></td>
                    <td colSpan={7} className="whitespace-normal text-sm text-red-800">{r.error}</td>
                    <td className="font-mono">{r.roundTrip.toFixed(0)} ms</td>
                    <td>{r.retryable && <button type="button" className="btn-secondary btn-sm" onClick={() => sendOne(r.body, `Retry of #${r.n}`)}>Retry</button>}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>
    </div>
  );
}
