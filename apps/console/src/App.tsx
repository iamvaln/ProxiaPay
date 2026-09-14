import { Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session';
import { Shell } from './components/Shell';
import { SignInPage } from './pages/SignIn';
import { HomePage } from './pages/Home';
import { ApprovalsPage } from './pages/Approvals';
import { TransactionsPage } from './pages/Transactions';
import { TransactionDetailPage } from './pages/TransactionDetail';
import { PreviewsPage } from './pages/Previews';
import { ProjectsPage } from './pages/Projects';
import { ProjectDetailPage } from './pages/ProjectDetail';
import { ConfigurationPage } from './pages/Configuration';
import { RouteDetailPage } from './pages/RouteDetail';
import { TreasuryPage } from './pages/Treasury';
import { FloatDetailPage } from './pages/FloatDetail';
import { ReconciliationPage } from './pages/Reconciliation';
import { DiscrepancyPage } from './pages/Discrepancy';
import { OversightPage } from './pages/Oversight';
import { SearchPage } from './pages/Search';

function Guarded({ children }: { children: React.ReactNode }) {
  const { me, loading } = useSession();
  if (loading) return <p className="muted" style={{ padding: 24 }}>…</p>;
  if (!me || !me.second_factor_complete) return <Navigate to="/sign-in" replace />;
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/" element={<Guarded><HomePage /></Guarded>} />
        <Route path="/approvals" element={<Guarded><ApprovalsPage /></Guarded>} />
        <Route path="/search" element={<Guarded><SearchPage /></Guarded>} />
        <Route path="/transactions" element={<Guarded><TransactionsPage /></Guarded>} />
        <Route path="/transactions/previews" element={<Guarded><PreviewsPage /></Guarded>} />
        <Route path="/transactions/:reference" element={<Guarded><TransactionDetailPage /></Guarded>} />
        <Route path="/projects" element={<Guarded><ProjectsPage /></Guarded>} />
        <Route path="/projects/:id" element={<Guarded><ProjectDetailPage /></Guarded>} />
        <Route path="/configuration" element={<Guarded><ConfigurationPage /></Guarded>} />
        <Route path="/configuration/routes/:id" element={<Guarded><RouteDetailPage /></Guarded>} />
        <Route path="/configuration/providers/:id" element={<Guarded><ConfigurationPage /></Guarded>} />
        <Route path="/treasury" element={<Guarded><TreasuryPage /></Guarded>} />
        <Route path="/treasury/float" element={<Guarded><TreasuryPage /></Guarded>} />
        <Route path="/treasury/float/:id" element={<Guarded><FloatDetailPage /></Guarded>} />
        <Route path="/reconciliation" element={<Guarded><ReconciliationPage /></Guarded>} />
        <Route path="/reconciliation/discrepancies" element={<Guarded><ReconciliationPage /></Guarded>} />
        <Route path="/reconciliation/discrepancies/:id" element={<Guarded><DiscrepancyPage /></Guarded>} />
        <Route path="/reconciliation/runs/:id" element={<Guarded><ReconciliationPage /></Guarded>} />
        <Route path="/oversight/*" element={<Guarded><OversightPage /></Guarded>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}
