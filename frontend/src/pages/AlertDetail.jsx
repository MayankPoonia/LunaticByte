// Alert investigation: transaction, feature values, rules, AI score and factors, card history,
// claim / close (analyst) and maker-checker decision (manager).
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useApi, useLiveRefresh, useSession } from '../lib/session';
import { dateTime, money } from '../lib/format';
import { Badge, DecisionBadge, ErrorBanner, KeyValue, Loading, Notice, PageHeader, PriorityBadge, ReasonCodes, Section, StatusBadge, TableWrap } from '../components/ui';
import { AuditTimeline, FeatureTable, ModelPanel, RuleTable } from '../components/explain';

const MIN_COMMENT = 10;

function CommentForm({ title, options, submitLabel, onSubmit, note }) {
  const [choice, setChoice] = useState('');
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const short = comment.trim().length < MIN_COMMENT;
  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!choice || short) return;
    setBusy(true);
    try {
      await onSubmit(choice, comment.trim());
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <fieldset>
        <legend className="label">{title}</legend>
        <div className="space-y-2">
          {options.map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2 text-sm">
              <input type="radio" name="choice" value={value} checked={choice === value} onChange={() => setChoice(value)} className="mt-1" />
              <span><span className="font-medium text-slate-900">{label}</span>{hint && <span className="block text-xs text-slate-500">{hint}</span>}</span>
            </label>
          ))}
        </div>
        {touched && !choice && <p className="mt-1 text-xs text-red-700">Choose an outcome.</p>}
      </fieldset>
      <div>
        <label className="label" htmlFor="comment">Comment</label>
        <textarea id="comment" rows={3} className="input" value={comment} onChange={(e) => setComment(e.target.value)} onBlur={() => setTouched(true)} />
        <p className={`mt-1 text-xs ${touched && short ? 'text-red-700' : 'text-slate-500'}`}>At least {MIN_COMMENT} characters ({comment.trim().length} entered).</p>
      </div>
      {note}
      <button type="submit" className="btn-primary" disabled={busy}>{submitLabel(choice)}</button>
    </form>
  );
}

export default function AlertDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const detail = useApi(`/alerts/${id}`);
  const audit = useApi(`/audit/ALERT/${id}`);
  const config = useApi('/config');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useLiveRefresh(['alert_updated', 'card_updated'], () => {
    detail.reload();
    audit.reload();
  });

  if (detail.error) return <ErrorBanner error={detail.error.status === 404 ? 'Alert not found.' : detail.error} />;
  if (!detail.data) return <Loading />;
  const { alert: a, transaction: t, card, card_history: history } = detail.data;
  const limitParam = config.data && config.data.params.find((p) => p.key === 'maker_checker_limit');
  const limit = limitParam ? Number(limitParam.value) : 100000;
  const needsManager = Number(a.amount) > limit;
  const mine = a.claimed_by === user.user_id || a.claimed_by === `${user.user_id}`;

  async function act(path, body, done) {
    setError('');
    setMessage('');
    try {
      const { data } = await api(path, { method: 'POST', body });
      setMessage(done(data));
      detail.reload();
      audit.reload();
    } catch (err) {
      if (err.status === 409) setError(`${err.message}. Another user changed this alert; the view has been refreshed.`);
      else if (err.status === 403) setError(`${err.message}.`);
      else setError(errorText(err));
      detail.reload();
    }
  }

  return (
    <div>
      <PageHeader title={`Alert ${a.alert_id}`} subtitle={`Raised ${dateTime(a.created_at)} for transaction ${a.txn_id}`}
        actions={<Link to="/alerts" className="btn-secondary">Back to queue</Link>} />
      <ErrorBanner error={error} />
      {message && <Notice tone="green">{message}</Notice>}

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Alert" className="lg:col-span-2">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <PriorityBadge value={a.priority} />
            <StatusBadge value={a.status} />
            {a.sla_breached && <Badge tone="red">SLA_BREACHED</Badge>}
            <ReasonCodes codes={a.reason_codes} />
          </div>
          <KeyValue items={[
            ['Amount', money(a.amount)], ['SLA due', dateTime(a.sla_due_at)], ['Merchant', a.merchant_name], ['Channel / city', `${t.channel} / ${t.txn_city}, ${t.txn_country}`],
            ['Transaction', <Link key="t" className="mono text-brand-700 hover:underline" to={`/transactions/${t.txn_id}`}>{t.txn_id}</Link>], ['Transaction time', dateTime(t.txn_ts)],
            ['Claimed by', a.claimed_by_name], ['Proposed by', a.proposed_by_name],
            ['Analyst comment', a.analyst_comment], ['Manager comment', a.manager_comment],
          ]} />
        </Section>

        <Section title="Action">
          {a.status === 'OPEN' && user.role === 'ANALYST' && (
            <button type="button" className="btn-primary" onClick={() => act(`/alerts/${id}/claim`, undefined, () => 'You claimed this alert. It is locked to you.')}>Claim alert</button>
          )}
          {a.status === 'OPEN' && user.role !== 'ANALYST' && <p className="muted">Waiting for an analyst to claim this alert.</p>}
          {a.status === 'IN_REVIEW' && mine && (
            <CommentForm title="Outcome" submitLabel={(c) => (c === 'FALSE_POSITIVE' && needsManager ? 'Send to manager' : 'Close alert')}
              options={[['CONFIRMED_FRAUD', 'Confirmed fraud', 'Closes the alert and blocks the card'],
                ['FALSE_POSITIVE', 'False positive', needsManager ? `Above ${money(limit)}: needs Fraud Risk Manager approval` : 'Closes the alert; the cardholder is notified']]}
              onSubmit={(outcome, comment) => act(`/alerts/${id}/close`, { outcome, comment }, (d) => (d.status === 'PENDING_MANAGER_APPROVAL' ? 'Sent to a Fraud Risk Manager for approval.' : `Alert closed as ${d.status}.`))} />
          )}
          {a.status === 'IN_REVIEW' && !mine && <p className="muted">Claimed by {a.claimed_by_name}. Only the claiming analyst can close it.</p>}
          {a.status === 'PENDING_MANAGER_APPROVAL' && user.role === 'MANAGER' && (
            <CommentForm title="Decision on the FALSE_POSITIVE proposal" submitLabel={(c) => (c === 'REJECT' ? 'Reject proposal' : 'Approve release')}
              options={[['APPROVE', 'Approve', 'Alert becomes FALSE_POSITIVE; the cardholder is notified'], ['REJECT', 'Reject', 'Alert becomes CONFIRMED_FRAUD; the card is blocked']]}
              note={<p className="text-xs text-slate-500">Maker-checker: the proposer ({a.proposed_by_name}) cannot approve their own proposal.</p>}
              onSubmit={(decision, comment) => act(`/alerts/${id}/manager-decision`, { decision, comment }, (d) => `Decision recorded: ${d.status}.`)} />
          )}
          {a.status === 'PENDING_MANAGER_APPROVAL' && user.role !== 'MANAGER' && <p className="muted">Waiting for a Fraud Risk Manager to approve or reject.</p>}
          {['CONFIRMED_FRAUD', 'FALSE_POSITIVE'].includes(a.status) && <p className="muted">Closed {dateTime(a.closed_at)}.</p>}
        </Section>
      </div>

      <Section className="mt-6" title="AI fraud score"><ModelPanel txn={t} /></Section>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="Feature values used"><FeatureTable features={t.features} /></Section>
        <Section title="Triggered rules"><RuleTable rules={t.rule_results} /></Section>
      </div>

      <Section className="mt-6" title={`Card ${card.masked}`}>
        <div className="mb-5">
          <KeyValue items={[['Status', <StatusBadge key="s" value={card.card_status} />], ['Type', card.card_type], ['Home', `${card.home_city}, ${card.home_country}`],
            ['Daily limit', money(card.daily_limit)], ['International', card.international_enabled ? 'Enabled' : 'Not enabled'], ['Expiry', card.expiry_date]]} />
        </div>
        <TableWrap>
          <table className="table">
            <thead><tr><th>Transaction</th><th>Time</th><th>Amount</th><th>Merchant</th><th>Channel</th><th>City</th><th>Status</th><th>Source</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.txn_id} className={h.txn_id === t.txn_id ? 'bg-brand-50/50' : ''}>
                  <td className="mono">{h.txn_id}</td><td>{dateTime(h.txn_ts)}</td><td>{money(h.amount)}</td><td>{h.merchant_name}</td><td>{h.channel}</td>
                  <td>{h.txn_city}</td><td><StatusBadge value={h.status} /></td><td className="text-xs">{h.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>

      <Section className="mt-6" title="Decision"><div className="flex items-center gap-3"><DecisionBadge value={t.decision} /><span className="muted">rules-only decision {t.rules_decision}</span></div></Section>
      <Section className="mt-6" title="Alert audit trail"><AuditTimeline events={audit.data && audit.data.events} exportPath={`/audit/ALERT/${id}?format=csv`} /></Section>
    </div>
  );
}
