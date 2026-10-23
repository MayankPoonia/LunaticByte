// Audit trail (FR-8): recent events, and the full ordered history of one transaction, alert or card.
import { useState } from 'react';
import { useApi } from '../lib/session';
import { ErrorBanner, Loading, PageHeader, Section } from '../components/ui';
import { AuditTimeline } from '../components/explain';

export default function Audit() {
  const [entity, setEntity] = useState('TRANSACTION');
  const [entityId, setEntityId] = useState('');
  const [lookup, setLookup] = useState(null);
  const [filter, setFilter] = useState('');
  const recent = useApi(`/audit?limit=100${filter ? `&entity=${filter}` : ''}`);
  const one = useApi(lookup ? `/audit/${lookup.entity}/${encodeURIComponent(lookup.id)}` : null, [lookup]);

  return (
    <div>
      <PageHeader title="Audit trail" subtitle="Append-only record of every decision, status change and configuration change." />
      <Section title="Look up an entity">
        <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => { e.preventDefault(); if (entityId.trim()) setLookup({ entity, id: entityId.trim() }); }}>
          <div>
            <label className="label" htmlFor="entity">Entity</label>
            <select id="entity" className="input" value={entity} onChange={(e) => setEntity(e.target.value)}>
              <option value="TRANSACTION">Transaction</option><option value="ALERT">Alert</option><option value="CARD">Card</option><option value="CONFIG">Configuration key</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="eid">ID</label>
            <input id="eid" className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="T700000001, 12, C1001 or velocity_burst_count" />
          </div>
          <button type="submit" className="btn-primary">Show history</button>
        </form>
        {lookup && (
          <div className="mt-6 border-t border-slate-200 pt-5">
            <ErrorBanner error={one.error} />
            {one.loading ? <Loading /> : one.data && <AuditTimeline events={one.data.events} exportPath={`/audit/${lookup.entity}/${encodeURIComponent(lookup.id)}?format=csv`} />}
          </div>
        )}
      </Section>
      <Section className="mt-6" title="Recent events"
        actions={(
          <select aria-label="Filter by entity" className="input w-48 py-1.5" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All entities</option><option value="TRANSACTION">Transactions</option><option value="ALERT">Alerts</option>
            <option value="STEP_UP">Step-ups</option><option value="CARD">Cards</option><option value="CONFIG">Configuration</option>
          </select>
        )}>
        <ErrorBanner error={recent.error} onRetry={recent.reload} />
        {!recent.data ? <Loading /> : <AuditTimeline events={recent.data.events} />}
      </Section>
    </div>
  );
}
