// Transaction detail: decision, rule evaluation, features, model score, step-up and audit history.
import { Link, useParams } from 'react-router-dom';
import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { useApi, useLiveRefresh, useSession } from '../lib/session';
import { dateTime, money, ms } from '../lib/format';
import { DecisionBadge, ErrorBanner, KeyValue, Loading, PageHeader, PriorityBadge, ReasonCodes, Section, StatusBadge } from '../components/ui';
import { AuditTimeline, FeatureTable, ModelPanel, RuleTable } from '../components/explain';

export default function TransactionDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const detail = useApi(`/transactions/${id}`);
  const audit = useApi(`/audit/TRANSACTION/${id}`);
  const [error, setError] = useState('');
  useLiveRefresh(['transaction_updated', 'step_up_updated', 'alert_updated', 'alert_created'], () => {
    detail.reload();
    audit.reload();
  });

  if (detail.error) return <ErrorBanner error={detail.error.status === 404 ? 'Transaction not found.' : detail.error} />;
  if (!detail.data) return <Loading />;
  const { transaction: t, step_up: s, alert: a } = detail.data;

  async function expire() {
    setError('');
    try {
      await api(`/demo/step-ups/${s.step_up_id}/expire`, { method: 'POST' });
      detail.reload();
      audit.reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div>
      <PageHeader title={`Transaction ${t.txn_id}`} subtitle={`${t.source} transaction on card ${t.card_id} (XXXXXXXXXXXX${t.card_last4})`}
        actions={<Link to="/transactions" className="btn-secondary">Back to transactions</Link>} />
      <ErrorBanner error={error} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Decision" className="lg:col-span-2">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <DecisionBadge value={t.decision} />
            <StatusBadge value={t.status} />
            <ReasonCodes codes={t.reason_codes} empty="No reason codes" />
          </div>
          <KeyValue items={[
            ['Amount', money(t.amount)], ['Transaction time', dateTime(t.txn_ts)], ['Merchant', `${t.merchant_name || t.merchant_id} (${t.merchant_risk || '-'})`],
            ['MCC / channel', `${t.mcc} / ${t.channel}`], ['Location', `${t.txn_city}, ${t.txn_country}`], ['Rule risk score', t.rule_risk_score ?? 'empty (hard stop)'],
            ['Processed', dateTime(t.processed_at)], ['Server processing', ms(t.processing_ms)], ['Configuration version', t.config_version],
          ]} />
        </Section>
        <div className="space-y-6">
          {s && (
            <Section title="Step-up verification">
              <KeyValue items={[['Status', <StatusBadge key="s" value={s.status} />], ['Expires', dateTime(s.expires_at)], ['Wrong OTP attempts', s.attempts], ['Resolved', dateTime(s.resolved_at)]]} />
              {s.status === 'PENDING' && user.role === 'MANAGER' && (
                <div className="mt-4 border-t border-slate-100 pt-4">
                  <button type="button" className="btn-secondary btn-sm" onClick={expire}>Expire now (demo)</button>
                  <p className="mt-2 text-xs text-slate-500">Moves the expiry to now and runs the regular expiry job, to show STEP_UP_TIMEOUT without waiting 15 minutes.</p>
                </div>
              )}
              {s.status === 'PENDING' && <p className="mt-3 text-xs text-slate-500">The cardholder confirms on their own screen (Verify payments) with the simulated OTP.</p>}
            </Section>
          )}
          {a && (
            <Section title="Alert">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><PriorityBadge value={a.priority} /><StatusBadge value={a.status} /></div>
                <Link to={`/alerts/${a.alert_id}`} className="text-sm text-brand-700 hover:underline">Open alert {a.alert_id}</Link>
              </div>
              <p className="mt-2 text-xs text-slate-500">SLA due {dateTime(a.sla_due_at)}</p>
            </Section>
          )}
        </div>
      </div>
      {t.source !== 'HISTORY' && (
        <>
          <Section className="mt-6" title="AI fraud score"><ModelPanel txn={t} /></Section>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Section title="Rule evaluation (R1 to R13)"><RuleTable rules={t.rule_results} /></Section>
            <Section title="Feature values used"><FeatureTable features={t.features} /></Section>
          </div>
        </>
      )}
      <Section className="mt-6" title="Audit trail"><AuditTimeline events={audit.data && audit.data.events} exportPath={`/audit/TRANSACTION/${id}?format=csv`} /></Section>
    </div>
  );
}
