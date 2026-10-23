// Explainability panels: how each rule was evaluated, the feature values used, the model score with
// its top contributing factors, and the audit trail.
import { api } from '../lib/api';
import { dateTime, money, num } from '../lib/format';
import { Badge, Empty, ModelBadge, ScoreValue, TableWrap } from './ui';

export function RuleTable({ rules }) {
  if (!rules || !rules.length) return <Empty title="No rule evaluation stored">Loaded history is not re-evaluated.</Empty>;
  const evaluated = new Set(rules.map((r) => r.rule));
  const all = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13'];
  return (
    <TableWrap>
      <table className="table">
        <thead><tr><th>Rule</th><th>Reason code</th><th>Result</th><th>Points</th><th>Evaluation</th></tr></thead>
        <tbody>
          {all.map((id) => {
            const r = rules.find((x) => x.rule === id);
            if (!r) {
              return <tr key={id} className="text-slate-400"><td>{id}</td><td colSpan={4}>{evaluated.has('R3') ? 'Not evaluated (a blocking rule R3-R6 already triggered)' : 'Not evaluated (hard stop R1/R2)'}</td></tr>;
            }
            return (
              <tr key={id} className={r.triggered ? 'bg-amber-50/40' : ''}>
                <td className="font-medium">{r.rule}</td>
                <td className="mono">{r.code}</td>
                <td>{r.triggered ? <Badge tone="amber">Triggered</Badge> : <span className="text-slate-500">Not triggered</span>}</td>
                <td>{r.points ?? '-'}</td>
                <td className="whitespace-normal text-slate-600">{r.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

export function FeatureTable({ features }) {
  if (!features) return <Empty title="No features stored" />;
  const m = features.model || {};
  const rows = [
    ['velocity_10m', features.velocity_10m, 'Prior transactions in the 10 minutes before'],
    ['velocity_24h', features.velocity_24h, 'Prior transactions in the 24 hours before'],
    ['approved_today', money(features.approved_today), 'Approved amount earlier today (IST)'],
    ['avg_amount_30d', features.avg_amount_30d === null ? 'empty (no history)' : money(features.avg_amount_30d), 'Mean approved amount, last 30 days'],
    ['speed_kmph', features.speed_kmph === null ? 'empty' : num(features.speed_kmph), features.speed_reference
      ? `From ${features.speed_reference.txn_city}, ${features.speed_reference.minutes_ago} min earlier, ${num(features.speed_reference.distance_km)} km` : 'Only for physical transactions after a physical one within 6 hours'],
    ['new_merchant', features.new_merchant ? 'yes' : 'no', 'No transaction with this merchant in 90 days'],
    ['distance_from_home_km', m.distance_from_home_km === null || m.distance_from_home_km === undefined ? '-' : num(m.distance_from_home_km), 'Haversine distance from the home city'],
    ['amount_to_avg30_ratio', m.amount_to_avg30_ratio ? num(m.amount_to_avg30_ratio) : 'empty', 'Amount divided by avg_amount_30d'],
    ['local_hour', m.local_hour, 'Hour of the transaction in IST'],
    ['is_international', m.is_international, 'Transaction country differs from home country'],
    ['country_risk_high', m.country_risk_high, 'Transaction country risk level is HIGH'],
    ['card_age_days', m.card_age_days, 'Days since the card was issued'],
  ];
  return (
    <TableWrap>
      <table className="table">
        <thead><tr><th>Feature</th><th>Value</th><th>Meaning</th></tr></thead>
        <tbody>{rows.map(([k, v, d]) => <tr key={k}><td className="mono">{k}</td><td className="font-medium">{v ?? '-'}</td><td className="whitespace-normal text-slate-500">{d}</td></tr>)}</tbody>
      </table>
    </TableWrap>
  );
}

export function ModelPanel({ txn }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-6">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Fraud score</div>
          <div className="mt-1 text-2xl"><ScoreValue score={txn.fraud_score} /></div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Model status</div>
          <div className="mt-2"><ModelBadge status={txn.model_status} /></div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Rules-only decision</div>
          <div className="mt-2 text-sm font-medium">{txn.rules_decision || '-'}</div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Model version</div>
          <div className="mt-2 mono">{txn.model_version || '-'}</div>
        </div>
      </div>
      {txn.model_status === 'MODEL_UNAVAILABLE' && <p className="text-sm text-slate-600">AI score unavailable. The rules-only decision was returned.</p>}
      {txn.top_factors && txn.top_factors.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium text-slate-700">Top contributing factors (SHAP)</div>
          <ol className="space-y-1.5 text-sm">
            {txn.top_factors.map((f) => (
              <li key={f.feature} className="flex items-baseline gap-2">
                <span className={`text-xs font-medium ${f.direction === 'lowers' ? 'text-emerald-700' : 'text-red-700'}`}>{f.direction === 'lowers' ? 'lowers risk' : 'raises risk'}</span>
                <span className="text-slate-800">{f.text}</span>
                <span className="mono text-slate-400">({f.feature}, {f.contribution > 0 ? '+' : ''}{f.contribution})</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="text-xs text-slate-500">
        The model can only make a decision stricter: APPROVE becomes STEP_UP at 70% or more, STEP_UP becomes BLOCK at 90% or more. It never relaxes a rule decision.
      </p>
    </div>
  );
}

export function AuditTimeline({ events, exportPath }) {
  async function download() {
    const res = await api(exportPath, { raw: true });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${exportPath.split('/').slice(-2).join('_').split('?')[0]}_audit.csv`;
    a.click();
  }
  return (
    <div>
      {exportPath && <div className="mb-3 flex justify-end"><button type="button" className="btn-secondary btn-sm" onClick={download}>Export CSV</button></div>}
      {!events || !events.length ? <Empty title="No audit events" /> : (
        <ol className="space-y-3">
          {events.map((e) => (
            <li key={e.audit_id} className="border-l-2 border-slate-200 pl-4">
              <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="font-medium text-slate-900">{e.action}</span>
                {(e.from_status || e.to_status) && <span className="text-slate-600">{e.from_status || '-'} to {e.to_status || '-'}</span>}
                <span className="text-xs text-slate-500">{e.entity} {e.entity_id}</span>
              </div>
              <div className="text-xs text-slate-500">{dateTime(e.ts)} by {e.actor} ({e.role})</div>
              {e.comment && <div className="mt-1 text-sm text-slate-700">{e.comment}</div>}
              {e.details && e.details.before !== undefined && <div className="mt-1 mono text-slate-600">before {JSON.stringify(e.details.before)} after {JSON.stringify(e.details.after)}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
