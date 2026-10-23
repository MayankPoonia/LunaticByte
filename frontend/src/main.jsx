import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { SessionProvider, useSession } from './lib/session';
import Layout from './components/Layout';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Simulator from './pages/Simulator';
import Transactions from './pages/Transactions';
import TransactionDetail from './pages/TransactionDetail';
import Alerts from './pages/Alerts';
import AlertDetail from './pages/AlertDetail';
import Approvals from './pages/Approvals';
import Audit from './pages/Audit';
import Rules from './pages/Rules';
import Model from './pages/Model';
import TestRunner from './pages/TestRunner';
import { MyCards, MyMessages, MyTransactions, MyVerifications } from './pages/Cardholder';

const HOME = { ANALYST: '/alerts', MANAGER: '/overview', CARDHOLDER: '/my/verifications' };

function Protected({ roles, children }) {
  const { user } = useSession();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={HOME[user.role]} replace />;
  return children;
}

function Home() {
  const { user } = useSession();
  return <Navigate to={user ? HOME[user.role] : '/login'} replace />;
}

const STAFF = ['ANALYST', 'MANAGER'];

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route path="/overview" element={<Protected roles={STAFF}><Overview /></Protected>} />
        <Route path="/simulator" element={<Protected roles={STAFF}><Simulator /></Protected>} />
        <Route path="/transactions" element={<Protected roles={STAFF}><Transactions /></Protected>} />
        <Route path="/transactions/:id" element={<Protected roles={STAFF}><TransactionDetail /></Protected>} />
        <Route path="/alerts" element={<Protected roles={STAFF}><Alerts /></Protected>} />
        <Route path="/alerts/:id" element={<Protected roles={STAFF}><AlertDetail /></Protected>} />
        <Route path="/approvals" element={<Protected roles={['MANAGER']}><Approvals /></Protected>} />
        <Route path="/audit" element={<Protected roles={STAFF}><Audit /></Protected>} />
        <Route path="/rules" element={<Protected roles={STAFF}><Rules /></Protected>} />
        <Route path="/model" element={<Protected roles={STAFF}><Model /></Protected>} />
        <Route path="/tests" element={<Protected roles={['MANAGER']}><TestRunner /></Protected>} />
        <Route path="/my/verifications" element={<Protected roles={['CARDHOLDER']}><MyVerifications /></Protected>} />
        <Route path="/my/transactions" element={<Protected roles={['CARDHOLDER']}><MyTransactions /></Protected>} />
        <Route path="/my/cards" element={<Protected roles={['CARDHOLDER']}><MyCards /></Protected>} />
        <Route path="/my/messages" element={<Protected roles={['CARDHOLDER']}><MyMessages /></Protected>} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
