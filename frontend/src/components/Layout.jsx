// Application shell: sidebar navigation (by role), top bar with the signed-in user and live status.
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';

const NAV = {
  ANALYST: [
    ['/overview', 'Overview'], ['/simulator', 'Transaction simulator'], ['/transactions', 'Transactions'], ['/alerts', 'Alert queue'],
    ['/audit', 'Audit trail'], ['/rules', 'Rule configuration'], ['/model', 'Model'],
  ],
  MANAGER: [
    ['/overview', 'Fraud dashboard'], ['/simulator', 'Transaction simulator'], ['/transactions', 'Transactions'], ['/alerts', 'Alert queue'],
    ['/approvals', 'Approvals'], ['/audit', 'Audit trail'], ['/rules', 'Rule configuration'], ['/model', 'Model'], ['/tests', 'Test runner'],
  ],
  CARDHOLDER: [['/my/verifications', 'Verify payments'], ['/my/transactions', 'My transactions'], ['/my/cards', 'My cards'], ['/my/messages', 'Messages']],
};

const ROLE_LABEL = { ANALYST: 'Fraud Analyst', MANAGER: 'Fraud Risk Manager', CARDHOLDER: 'Cardholder' };

export default function Layout() {
  const { user, logout, live } = useSession();
  const navigate = useNavigate();
  const items = NAV[user.role] || [];
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:block">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="text-sm font-semibold text-brand-700">FraudShield</div>
          <div className="text-xs text-slate-500">Kaveri National Bank</div>
        </div>
        <nav className="space-y-0.5 p-3" aria-label="Main">
          {items.map(([to, label]) => (
            <NavLink key={to} to={to}
              className={({ isActive }) => `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3">
          <nav className="flex gap-1 overflow-x-auto md:hidden" aria-label="Main">
            {items.map(([to, label]) => (
              <NavLink key={to} to={to} className={({ isActive }) => `whitespace-nowrap rounded px-2 py-1 text-xs ${isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600'}`}>{label}</NavLink>
            ))}
          </nav>
          <div className="hidden items-center gap-2 text-xs text-slate-500 md:flex">
            <span className={`h-2 w-2 rounded-full ${live === 'live' ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
            {live === 'live' ? 'Live updates connected' : 'Reconnecting to live updates'}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-sm font-medium text-slate-900">{user.display_name}</div>
              <div className="text-xs text-slate-500">{ROLE_LABEL[user.role]} ({user.username})</div>
            </div>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { logout(); navigate('/login'); }}>Sign out</button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
