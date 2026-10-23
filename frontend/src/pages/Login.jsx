// Sign-in page. In demo mode a "Sign in as" selector fills in seeded demo credentials; the role is
// still decided by the server from the authenticated account.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useSession } from '../lib/session';

const ROLE_LABEL = { ANALYST: 'Fraud Analyst', MANAGER: 'Fraud Risk Manager', CARDHOLDER: 'Cardholder' };
const HOME = { ANALYST: '/alerts', MANAGER: '/overview', CARDHOLDER: '/my/verifications' };

export default function Login() {
  const { login } = useSession();
  const navigate = useNavigate();
  const [demo, setDemo] = useState({ accounts: [], password: '' });
  const [selected, setSelected] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/demo-accounts').then(({ data }) => setDemo(data)).catch(() => {});
  }, []);

  function choose(value) {
    setSelected(value);
    setError('');
    if (value) {
      setUsername(value);
      setPassword(demo.password);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await login(username.trim(), password);
      navigate(HOME[user.role]);
    } catch (err) {
      setError(err.status === 401 ? 'The username or password is not correct. Check the details and try again.' : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const groups = ['MANAGER', 'ANALYST', 'CARDHOLDER'].map((role) => [role, demo.accounts.filter((a) => a.role === role)]).filter(([, a]) => a.length);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="text-lg font-semibold text-brand-700">FraudShield</div>
          <div className="text-sm text-slate-500">Kaveri National Bank - Card fraud operations</div>
        </div>
        <form onSubmit={submit} className="card space-y-5 p-8" noValidate>
          <h1 className="h1">Sign in</h1>
          {demo.demo_mode && (
            <div>
              <label htmlFor="who" className="label">Sign in as (demo accounts)</label>
              <select id="who" className="input" value={selected} onChange={(e) => choose(e.target.value)}>
                <option value="">Choose a role to fill in credentials</option>
                {groups.map(([role, accounts]) => (
                  <optgroup key={role} label={ROLE_LABEL[role]}>
                    {accounts.map((a) => <option key={a.username} value={a.username}>{a.display_name} - {a.username}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="username" className="label">Username</label>
            <input id="username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="password" className="label">Password</label>
            <input id="password" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <button type="submit" className="btn-primary w-full" disabled={busy || !username || !password}>{busy ? 'Signing in' : 'Sign in'}</button>
          {demo.demo_mode && (
            <p className="text-xs leading-relaxed text-slate-500">
              Demo environment: prefilled credentials exist only for the hackathon demo. Your access is decided by the server
              from the account you sign in with. Each browser tab keeps its own session, so you can sign in as an analyst in one tab and
              as a cardholder in another.
            </p>
          )}
        </form>
        <p className="mt-6 text-center text-sm text-slate-500">
          Simulated card gateway: <a href="/simulator" className="font-medium text-brand-700 hover:underline">open the transaction simulator</a>
        </p>
      </div>
    </div>
  );
}
