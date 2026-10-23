// Cardholder screens: verify doubtful payments ("Was this you?"), own transactions with neutral
// messages, own cards (with instant block) and the simulated SMS inbox where OTPs arrive.
import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { useApi, useLiveRefresh } from '../lib/session';
import { dateTime, money, relative } from '../lib/format';
import { Empty, ErrorBanner, Loading, Notice, PageHeader, Section, StatusBadge, TableWrap } from '../components/ui';

function VerificationCard({ s, onDone }) {
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function respond(response) {
    if (response === 'CONFIRM' && !/^\d{6}$/.test(otp)) {
      setError('Enter the 6-digit code from your messages.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { data } = await api(`/me/step-ups/${s.step_up_id}/respond`, { method: 'POST', body: { response, otp: response === 'CONFIRM' ? otp : undefined } });
      onDone(data.status === 'APPROVED' ? 'Thank you. The payment has been approved.' : 'The payment was declined and your card has been blocked for your safety.');
    } catch (err) {
      setError(err.body && err.body.error === 'STEP_UP_EXPIRED' ? 'This request has expired and the payment was declined.' : errorText(err));
      if (err.status === 409) onDone(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card p-6">
      <h2 className="h2">Was this you?</h2>
      <p className="mt-2 text-sm text-slate-700">{money(s.amount)} at {s.merchant_name || 'a merchant'} ({s.channel}, {s.txn_city}) on card {s.card}.</p>
      <p className="mt-1 text-xs text-slate-500">Requested {dateTime(s.txn_ts)}. Expires {relative(s.expires_at)}.</p>
      <div className="mt-5 max-w-xs">
        <label className="label" htmlFor={`otp-${s.step_up_id}`}>One-time code</label>
        <input id={`otp-${s.step_up_id}`} className="input font-mono tracking-widest" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} placeholder="6 digits" />
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex gap-3">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => respond('CONFIRM')}>Yes, it was me</button>
        <button type="button" className="btn-danger" disabled={busy} onClick={() => respond('NOT_ME')}>No, it was not me</button>
      </div>
    </div>
  );
}

export function MyVerifications() {
  const list = useApi('/me/step-ups');
  const messages = useApi('/me/notifications');
  const [done, setDone] = useState('');
  useLiveRefresh(['step_up_updated'], () => {
    list.reload();
    messages.reload();
  });
  const pending = list.data ? list.data.step_ups.filter((s) => s.status === 'PENDING') : [];
  const otpMessages = messages.data ? messages.data.notifications.filter((n) => n.kind === 'STEP_UP_OTP').slice(0, 3) : [];
  return (
    <div>
      <PageHeader title="Verify payments" subtitle="We ask you to confirm payments that look unusual before approving them." />
      <ErrorBanner error={list.error} onRetry={list.reload} />
      {done && <Notice tone="green">{done}</Notice>}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {!list.data ? <Loading /> : pending.length === 0 ? <div className="card"><Empty title="No payments waiting for your confirmation">New requests appear here automatically.</Empty></div>
            : pending.map((s) => <VerificationCard key={s.step_up_id} s={s} onDone={(msg) => { if (msg) setDone(msg); list.reload(); }} />)}
        </div>
        <Section title="Latest codes (simulated SMS)">
          {otpMessages.length === 0 ? <p className="muted">No codes yet.</p> : (
            <ul className="space-y-3 text-sm">{otpMessages.map((n) => <li key={n.notification_id}><p className="text-slate-800">{n.message}</p><p className="text-xs text-slate-500">{dateTime(n.created_at)}</p></li>)}</ul>
          )}
          <p className="mt-4 text-xs text-slate-500">Hackathon simulation: codes are written to the application log and shown here instead of being sent by SMS.</p>
        </Section>
      </div>
      {list.data && list.data.step_ups.some((s) => s.status !== 'PENDING') && (
        <Section className="mt-6" title="Earlier requests">
          <TableWrap>
            <table className="table">
              <thead><tr><th>Payment</th><th>Amount</th><th>Merchant</th><th>Result</th></tr></thead>
              <tbody>{list.data.step_ups.filter((s) => s.status !== 'PENDING').map((s) => (
                <tr key={s.step_up_id}><td>{dateTime(s.txn_ts)}</td><td>{money(s.amount)}</td><td>{s.merchant_name}</td><td><StatusBadge value={s.status} /></td></tr>
              ))}</tbody>
            </table>
          </TableWrap>
        </Section>
      )}
    </div>
  );
}

export function MyTransactions() {
  const list = useApi('/me/transactions');
  useLiveRefresh(['step_up_updated', 'card_updated'], list.reload);
  return (
    <div>
      <PageHeader title="My transactions" />
      <ErrorBanner error={list.error} onRetry={list.reload} />
      <Section>
        {!list.data ? <Loading /> : list.data.transactions.length === 0 ? <Empty title="No transactions yet" /> : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Time</th><th>Card</th><th>Amount</th><th>Merchant</th><th>Channel</th><th>City</th><th>Status</th><th>Details</th></tr></thead>
              <tbody>{list.data.transactions.map((t) => (
                <tr key={t.txn_id}><td>{dateTime(t.txn_ts)}</td><td className="mono">{t.card}</td><td>{money(t.amount)}</td><td>{t.merchant_name}</td><td>{t.channel}</td>
                  <td>{t.txn_city}</td><td><StatusBadge value={t.status} /></td><td className="whitespace-normal text-slate-600">{t.message}</td></tr>
              ))}</tbody>
            </table>
          </TableWrap>
        )}
      </Section>
    </div>
  );
}

export function MyCards() {
  const list = useApi('/me/cards');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  useLiveRefresh(['card_updated'], list.reload);
  async function block(c) {
    if (!window.confirm(`Block card ${c.masked}? Payments on this card will be declined. Unblocking needs a call to the bank.`)) return;
    setError('');
    try {
      await api(`/me/cards/${c.card_id}/block`, { method: 'POST' });
      setDone(`Card ${c.masked} is now blocked.`);
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <div>
      <PageHeader title="My cards" />
      <ErrorBanner error={error || list.error} />
      {done && <Notice tone="green">{done}</Notice>}
      {!list.data ? <Loading /> : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.data.cards.map((c) => (
            <div key={c.card_id} className="card p-6">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-mono text-lg tracking-wider">{c.masked}</div>
                  <div className="mt-1 text-sm text-slate-500">{c.card_type} card, expires {c.expiry_date}</div>
                </div>
                <StatusBadge value={c.card_status} />
              </div>
              <div className="mt-4 text-sm text-slate-600">Daily limit {money(c.daily_limit)}; international use {c.international_enabled ? 'enabled' : 'not enabled'}</div>
              {c.card_status === 'ACTIVE' && <button type="button" className="btn-danger mt-5" onClick={() => block(c)}>Block card {c.masked.slice(-4)}</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MyMessages() {
  const list = useApi('/me/notifications');
  useLiveRefresh(['step_up_updated'], list.reload);
  return (
    <div>
      <PageHeader title="Messages" subtitle="Simulated SMS messages from the bank. Nothing is actually sent in the hackathon environment." />
      <Section>
        {!list.data ? <Loading /> : list.data.notifications.length === 0 ? <Empty title="No messages" /> : (
          <ul className="divide-y divide-slate-100">{list.data.notifications.map((n) => (
            <li key={n.notification_id} className="py-3"><p className="text-sm text-slate-800">{n.message}</p><p className="mt-1 text-xs text-slate-500">{dateTime(n.created_at)}</p></li>
          ))}</ul>
        )}
      </Section>
    </div>
  );
}
