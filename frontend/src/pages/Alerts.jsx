// Analyst alert queue (FR-6): ordered by priority then sla_due_at; new alerts appear live.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useApi, useLiveRefresh, useSession } from '../lib/session';
import { dateTime, money, relative } from '../lib/format';
import { Badge, Empty, ErrorBanner, Loading, PageHeader, PriorityBadge, ReasonCodes, ScoreValue, Section, StatusBadge, TableWrap } from '../components/ui';

const TABS = [['active', 'Active'], ['OPEN', 'Open'], ['IN_REVIEW', 'In review'], ['PENDING_MANAGER_APPROVAL', 'Pending approval'], ['closed', 'Closed'], ['all', 'All']];

export function AlertTable({ alerts, onClaim, canClaim, busy }) {
  return (
    <TableWrap>
      <table className="table">
        <thead><tr><th>Alert</th><th>Priority</th><th>Status</th><th>SLA</th><th>Transaction</th><th>Amount</th><th>Merchant</th><th>Reasons</th><th>Fraud score</th><th>Owner</th><th /></tr></thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.alert_id} className={a.sla_breached && !a.closed_at ? 'bg-red-50/50' : ''}>
              <td><Link to={`/alerts/${a.alert_id}`} className="font-medium text-brand-700 hover:underline">{a.alert_id}</Link></td>
              <td><PriorityBadge value={a.priority} /></td>
              <td><StatusBadge value={a.status} /></td>
              <td>
                {a.sla_breached ? <Badge tone="red">SLA_BREACHED</Badge> : <span className="text-xs text-slate-600">{a.closed_at ? 'met' : `due ${relative(a.sla_due_at)}`}</span>}
                <div className="text-xs text-slate-500">{dateTime(a.sla_due_at)}</div>
              </td>
              <td><Link to={`/transactions/${a.txn_id}`} className="mono text-brand-700 hover:underline">{a.txn_id}</Link><div className="text-xs text-slate-500">XXXX{a.card_last4}</div></td>
              <td>{money(a.amount)}</td>
              <td>{a.merchant_name}</td>
              <td className="whitespace-normal"><ReasonCodes codes={a.reason_codes} /></td>
              <td><ScoreValue score={a.fraud_score} /></td>
              <td className="text-xs">{a.claimed_by_name || '-'}</td>
              <td>{canClaim && a.status === 'OPEN' && <button type="button" className="btn-primary btn-sm" disabled={busy === a.alert_id} onClick={() => onClaim(a.alert_id)}>Claim</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export default function Alerts() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [tab, setTab] = useState('active');
  const [priority, setPriority] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const list = useApi(`/alerts?status=${tab}${priority ? `&priority=${priority}` : ''}`);
  useLiveRefresh(['alert_created', 'alert_updated'], list.reload);

  async function claim(id) {
    setBusy(id);
    setError('');
    try {
      await api(`/alerts/${id}/claim`, { method: 'POST' });
      navigate(`/alerts/${id}`);
    } catch (err) {
      setError(err.status === 409 ? `Alert ${id} was already claimed by another analyst. The queue has been refreshed.` : errorText(err));
      list.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="Alert queue" subtitle="Ordered by priority, then SLA due time. HIGH alerts are due within 30 minutes, MEDIUM within 4 hours." />
      <ErrorBanner error={error || list.error} />
      <Section>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap gap-1" role="tablist">
            {TABS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}>{label}</button>
            ))}
          </div>
          <div>
            <label className="label" htmlFor="priority">Priority</label>
            <select id="priority" className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">All</option><option>HIGH</option><option>MEDIUM</option>
            </select>
          </div>
        </div>
        {!list.data ? <Loading /> : list.data.alerts.length === 0 ? <Empty title="No alerts in this view">New fraud-suspicion blocks appear here automatically.</Empty>
          : <AlertTable alerts={list.data.alerts} onClaim={claim} canClaim={user.role === 'ANALYST'} busy={busy} />}
      </Section>
    </div>
  );
}
