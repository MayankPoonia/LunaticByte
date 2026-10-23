// Rule configuration: every threshold, window, point value and list. Managers can edit; each change
// creates a new configuration version and an audit entry with before/after values.
import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { useApi, useSession } from '../lib/session';
import { dateTime } from '../lib/format';
import { Badge, ErrorBanner, Loading, Notice, PageHeader, Section, TableWrap } from '../components/ui';

function parseValue(original, text) {
  if (Array.isArray(original)) return text.split(/[,\s|]+/).filter(Boolean);
  if (typeof original === 'number') return Number(text);
  if (typeof original === 'boolean') return text === 'true';
  if (original && typeof original === 'object') return JSON.parse(text);
  return text;
}

const show = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function Rules() {
  const { user } = useSession();
  const cfg = useApi('/config');
  const [editing, setEditing] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const canEdit = user.role === 'MANAGER';

  async function save(p) {
    setError('');
    let value;
    try {
      value = parseValue(p.value, text.trim());
    } catch {
      setError('Enter valid JSON for this value, for example {"R7": 25, "R8": 30}.');
      return;
    }
    try {
      const { data } = await api(`/config/${p.key}`, { method: 'PUT', body: { value } });
      setSaved(`${p.key} changed from ${show(data.before)} to ${show(data.after)} (version ${data.version}). New transactions use it immediately.`);
      setEditing(null);
      cfg.reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div>
      <PageHeader title="Rule configuration" subtitle={canEdit ? 'Changes take effect for the next transaction, without a code release.' : 'Read-only for analysts. A Fraud Risk Manager maintains the configuration.'} />
      <ErrorBanner error={error || cfg.error} />
      {saved && <Notice tone="green">{saved}</Notice>}
      <Section title={cfg.data ? `Current configuration (version ${cfg.data.version})` : 'Current configuration'}>
        {!cfg.data ? <Loading /> : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Parameter</th><th>Value</th><th>Source</th><th>Description</th><th>Last changed</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {cfg.data.params.map((p) => (
                  <tr key={p.key}>
                    <td className="mono">{p.key}</td>
                    <td className="whitespace-normal">
                      {editing === p.key ? (
                        <input aria-label={`New value for ${p.key}`} className="input py-1" value={text} onChange={(e) => setText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') save(p); if (e.key === 'Escape') setEditing(null); }} autoFocus />
                      ) : <span className="font-medium">{show(p.value)}</span>}
                    </td>
                    <td><Badge tone={p.source === 'file' ? 'blue' : p.source === 'user' ? 'amber' : 'gray'}>{p.source}</Badge></td>
                    <td className="whitespace-normal text-slate-500">{p.description}</td>
                    <td className="text-xs text-slate-500">{p.updated_by ? `${p.updated_by}, ${dateTime(p.updated_at)}` : '-'}</td>
                    {canEdit && (
                      <td>
                        {editing === p.key ? (
                          <div className="flex gap-2"><button type="button" className="btn-primary btn-sm" onClick={() => save(p)}>Save</button><button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(null)}>Cancel</button></div>
                        ) : <button type="button" className="btn-secondary btn-sm" onClick={() => { setEditing(p.key); setText(show(p.value)); setSaved(''); }}>Edit</button>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="mt-4 text-xs text-slate-500">Source "file" means loaded from case_01_rules_config_V1.0.json, "default" means the case-study default was used because the file did not provide it, "user" means changed here.</p>
      </Section>
      {cfg.data && (
        <Section className="mt-6" title="Versions">
          <ul className="space-y-1 text-sm">{cfg.data.versions.map((v) => <li key={v.version}>Version {v.version} by {v.changed_by}, {dateTime(v.changed_at)}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}
