// Transaction list with filters; live transactions by default, history on request.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useLiveRefresh } from '../lib/session';
import { dateTime, money, ms } from '../lib/format';
import { DecisionBadge, Empty, ErrorBanner, Loading, ModelBadge, PageHeader, ReasonCodes, ScoreValue, Section, StatusBadge, TableWrap } from '../components/ui';

export default function Transactions() {
  const [source, setSource] = useState('live');
  const [decision, setDecision] = useState('');
  const [q, setQ] = useState('');
  const params = new URLSearchParams({ source, limit: '200', ...(decision ? { decision } : {}), ...(q ? { q } : {}) });
  const list = useApi(`/transactions?${params}`);
  useLiveRefresh(['transaction_decided', 'transaction_updated'], list.reload);

  return (
    <div>
      <PageHeader title="Transactions" subtitle="Every decision with its reasons, rule score and model score." />
      <ErrorBanner error={list.error} onRetry={list.reload} />
      <Section>
        <div className="mb-5 flex flex-wrap items-end gap-4">
          <div>
            <label className="label" htmlFor="source">Source</label>
            <select id="source" className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="live">Decided by FraudShield</option><option value="SIMULATOR">Simulator</option><option value="API">Gateway API</option>
              <option value="BATCH">Batch</option><option value="HISTORY">Loaded history</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="decision">Decision</label>
            <select id="decision" className="input" value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="">All</option><option>APPROVE</option><option>STEP_UP</option><option>BLOCK</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="q">Transaction or card ID</label>
            <input id="q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="T700000001 or C1001" />
          </div>
        </div>
        {list.loading && !list.data ? <Loading /> : !list.data || list.data.transactions.length === 0 ? <Empty title="No transactions match these filters" /> : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Transaction</th><th>Transaction time</th><th>Card</th><th>Amount</th><th>Merchant</th><th>Channel</th><th>City</th><th>Decision</th><th>Status</th><th>Reasons</th><th>Rule score</th><th>Fraud score</th><th>Model</th><th>Server</th></tr></thead>
              <tbody>
                {list.data.transactions.map((t) => (
                  <tr key={t.txn_id}>
                    <td><Link to={`/transactions/${t.txn_id}`} className="mono text-brand-700 hover:underline">{t.txn_id}</Link></td>
                    <td>{dateTime(t.txn_ts)}</td>
                    <td className="mono">{t.card_id} / XXXX{t.card_last4}</td>
                    <td>{money(t.amount)}</td>
                    <td>{t.merchant_name}</td>
                    <td>{t.channel}</td>
                    <td>{t.txn_city}</td>
                    <td><DecisionBadge value={t.decision} /></td>
                    <td><StatusBadge value={t.status} /></td>
                    <td className="whitespace-normal"><ReasonCodes codes={t.reason_codes} /></td>
                    <td>{t.rule_risk_score ?? '-'}</td>
                    <td><ScoreValue score={t.fraud_score} /></td>
                    <td>{t.source === 'HISTORY' ? '-' : <ModelBadge status={t.model_status} />}</td>
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
