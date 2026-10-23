// Fraud dashboard (FR-9). All figures come from /dashboard/summary, computed from PostgreSQL, and
// refresh automatically when transaction or alert events arrive.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useLiveRefresh } from '../lib/session';
import { dateTime, money, ms, pct } from '../lib/format';
import { DecisionBadge, Empty, ErrorBanner, Loading, ModelBadge, PageHeader, ReasonCodes, Section, Stat, StatusBadge, TableWrap } from '../components/ui';

function Bar({ label, value, total, tone }) {
  const width = total ? Math.max(2, (value / total) * 100) : 0;
  const color = tone === 'red' ? 'bg-red-600' : tone === 'amber' ? 'bg-amber-500' : tone === 'green' ? 'bg-emerald-600' : 'bg-brand-600';
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm"><span className="text-slate-700">{label}</span><span className="font-medium">{value}</span></div>
      <div className="h-2 rounded bg-slate-100"><div className={`h-2 rounded ${color}`} style={{ width: `${width}%` }} /></div>
    </div>
  );
}

export default function Overview() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const summary = useApi(`/dashboard/summary${qs ? `?${qs}` : ''}`);
  const recent = useApi('/transactions?source=live&limit=10');
  const system = useApi('/system/status');
  useLiveRefresh(['transaction_decided', 'transaction_updated', 'alert_created', 'alert_updated'], () => {
    summary.reload();
    recent.reload();
  });

  const s = summary.data;
  const total = s ? s.transactions.total : 0;
  const d = s ? s.transactions.by_decision : {};
  const open = s ? s.alerts.open_by_priority : {};

  return (
    <div>
      <PageHeader title="Fraud dashboard" subtitle="Decisions made by FraudShield (history excluded). Updates live."
        actions={(
          <div className="flex items-end gap-3">
            <div><label className="label" htmlFor="from">From</label><input id="from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div><label className="label" htmlFor="to">To</label><input id="to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            {(from || to) && <button type="button" className="btn-secondary" onClick={() => { setFrom(''); setTo(''); }}>Clear dates</button>}
          </div>
        )} />
      <ErrorBanner error={summary.error} onRetry={summary.reload} />
      {system.data && system.data.data && system.data.data.synthetic && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Running on the synthetic stand-in data pack (devdata). Copy the official files into data/ and reset to use them.
        </div>
      )}
      {!s ? <Loading /> : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Transactions decided" value={total} hint={`${d.APPROVE || 0} approved, ${d.STEP_UP || 0} step-up, ${d.BLOCK || 0} blocked`} />
            <Stat label="Block rate" value={pct(s.rates.block_rate)} tone={s.rates.block_rate > 0.2 ? 'red' : undefined} />
            <Stat label="Step-up rate" value={pct(s.rates.step_up_rate)} />
            <Stat label="False-positive rate" value={pct(s.rates.false_positive_rate)} hint="FALSE_POSITIVE / closed alerts" />
            <Stat label="Open HIGH alerts" value={open.HIGH || 0} tone={(open.HIGH || 0) > 0 ? 'red' : undefined} />
            <Stat label="Open MEDIUM alerts" value={open.MEDIUM || 0} tone={(open.MEDIUM || 0) > 0 ? 'amber' : undefined} />
            <Stat label="SLA breaches" value={s.alerts.sla_breached_open} hint={`${s.alerts.sla_breached_closed_late} closed after SLA`} tone={s.alerts.sla_breached_open ? 'red' : undefined} />
            <Stat label="Authorisation latency" value={s.latency_ms.p95 === null ? '-' : `${s.latency_ms.p95.toFixed(1)} ms`} hint={`server p95 (p50 ${s.latency_ms.p50 === null ? '-' : s.latency_ms.p50.toFixed(1)} ms), ${s.latency_ms.samples} live requests`} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Section title="Transactions by decision">
              <div className="space-y-4">
                <Bar label="APPROVE" value={d.APPROVE || 0} total={total} tone="green" />
                <Bar label="STEP_UP" value={d.STEP_UP || 0} total={total} tone="amber" />
                <Bar label="BLOCK" value={d.BLOCK || 0} total={total} tone="red" />
              </div>
            </Section>
            <Section title="Top 5 reason codes">
              {s.top_reason_codes.length === 0 ? <Empty title="No reason codes yet" /> : (
                <div className="space-y-4">{s.top_reason_codes.map((r) => <Bar key={r.code} label={r.code} value={r.n} total={s.top_reason_codes[0].n} />)}</div>
              )}
            </Section>
            <Section title="Model">
              <div className="space-y-3 text-sm">
                {Object.entries(s.model.by_status).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between"><ModelBadge status={k === 'NONE' ? null : k} /><span className="font-medium">{v}</span></div>
                ))}
                <div className="flex items-center justify-between border-t border-slate-100 pt-3"><span className="text-slate-600">Decisions tightened by the model</span><span className="font-medium">{s.model.escalations}</span></div>
                {system.data && (
                  <div className="border-t border-slate-100 pt-3 text-xs text-slate-500">
                    Model service {system.data.model.status === 'UP' ? `up (${system.data.model.model_version})` : 'down'}; outbox pending {system.data.outbox.pending};
                    served by {system.data.instance}
                  </div>
                )}
              </div>
            </Section>
          </div>
        </>
      )}

      <Section className="mt-6" title="Latest decisions" actions={<Link to="/transactions" className="text-sm text-brand-700 hover:underline">View all</Link>}>
        {!recent.data ? <Loading /> : recent.data.transactions.length === 0 ? <Empty title="No transactions yet">Use the transaction simulator to send one.</Empty> : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Transaction</th><th>Processed</th><th>Card</th><th>Amount</th><th>Merchant</th><th>Decision</th><th>Status</th><th>Reasons</th><th>Server time</th></tr></thead>
              <tbody>
                {recent.data.transactions.map((t) => (
                  <tr key={t.txn_id}>
                    <td><Link to={`/transactions/${t.txn_id}`} className="mono text-brand-700 hover:underline">{t.txn_id}</Link></td>
                    <td>{dateTime(t.processed_at)}</td>
                    <td className="mono">XXXX{t.card_last4}</td>
                    <td>{money(t.amount)}</td>
                    <td>{t.merchant_name}</td>
                    <td><DecisionBadge value={t.decision} /></td>
                    <td><StatusBadge value={t.status} /></td>
                    <td className="whitespace-normal"><ReasonCodes codes={t.reason_codes} /></td>
                    <td>{ms(t.processing_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>
    </div>
  );
}
