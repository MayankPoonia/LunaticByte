// Small presentational components shared by all pages.
import { REASON_LABELS } from '../lib/format';

const TONES = {
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-100',
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
};

export function Badge({ tone = 'gray', children, title }) {
  return <span title={title} className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>{children}</span>;
}

const DECISION_TONE = { APPROVE: 'green', STEP_UP: 'amber', BLOCK: 'red' };
const STATUS_TONE = {
  APPROVED: 'green', STEP_UP_PENDING: 'amber', BLOCKED: 'red', OPEN: 'blue', IN_REVIEW: 'amber', PENDING_MANAGER_APPROVAL: 'amber',
  CONFIRMED_FRAUD: 'red', FALSE_POSITIVE: 'green', ACTIVE: 'green', EXPIRED: 'gray', PENDING: 'amber', CONFIRMED: 'green', DENIED: 'red',
};

export const DecisionBadge = ({ value }) => (value ? <Badge tone={DECISION_TONE[value] || 'gray'}>{value}</Badge> : <span className="text-slate-400">-</span>);
export const StatusBadge = ({ value }) => (value ? <Badge tone={STATUS_TONE[value] || 'gray'}>{value.replaceAll('_', ' ')}</Badge> : null);
export const PriorityBadge = ({ value }) => <Badge tone={value === 'HIGH' ? 'red' : 'amber'}>{value}</Badge>;

export function ModelBadge({ status }) {
  if (!status) return <span className="text-slate-400">-</span>;
  if (status === 'OK') return <Badge tone="blue">Model OK</Badge>;
  if (status === 'DISABLED') return <Badge tone="gray">AI disabled</Badge>;
  return <Badge tone="gray" title="Rules-only decision was returned">AI score unavailable</Badge>;
}

export function ReasonCodes({ codes, empty = 'None' }) {
  if (!codes || !codes.length) return <span className="text-slate-400">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {codes.map((c) => (
        <Badge key={c} tone={c === 'HIGH_FRAUD_SCORE_MODEL' ? 'blue' : 'gray'} title={REASON_LABELS[c]}>{c}</Badge>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="mt-1 muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3">
          <h2 className="h2">{title}</h2>
          {actions}
        </div>
      )}
      <div className="card-pad">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }) {
  const color = tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : 'text-slate-900';
  return (
    <div className="card card-pad">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  return (
    <div role="alert" className="mb-4 flex items-start justify-between gap-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span>{typeof error === 'string' ? error : error.message}</span>
      {onRetry && <button type="button" className="btn-secondary btn-sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Notice({ tone = 'blue', children }) {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-900' : tone === 'green' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-brand-100 bg-brand-50 text-brand-800';
  return <div className={`mb-4 rounded-md border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

export function Empty({ title, children }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children && <p className="mt-1 text-sm text-slate-500">{children}</p>}
    </div>
  );
}

export function Loading({ label = 'Loading' }) {
  return <div className="px-4 py-10 text-center text-sm text-slate-500">{label}...</div>;
}

export function KeyValue({ items }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="mt-0.5 text-sm text-slate-900">{v === null || v === undefined || v === '' ? '-' : v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TableWrap({ children }) {
  return <div className="-mx-5 -my-5 overflow-x-auto">{children}</div>;
}

export function ScoreValue({ score }) {
  if (score === null || score === undefined) return <span className="text-slate-400">-</span>;
  const v = Number(score);
  const tone = v >= 0.9 ? 'text-red-700' : v >= 0.7 ? 'text-amber-700' : 'text-slate-700';
  return <span className={`font-medium ${tone}`}>{(v * 100).toFixed(1)}%</span>;
}
