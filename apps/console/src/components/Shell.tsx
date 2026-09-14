import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { post } from '../lib/api';
import { useSession, useT } from '../lib/session';

/** The persistent environment band (console spec 2) sits above everything; areas appear where the administrator holds a permission within them (3.1). */
export function Shell({ children }: { children: React.ReactNode }) {
  const { me, has, refresh } = useSession();
  const t = useT();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  if (!me) return null;
  const areas = [
    { to: '/', label: t('nav.home'), show: true },
    { to: '/transactions', label: t('nav.transactions'), show: has('transactions.read') },
    { to: '/projects', label: t('nav.projects'), show: has('projects.read') },
    { to: '/configuration', label: t('nav.configuration'), show: has('reference.read') || has('routes.read') || has('providers.read') },
    { to: '/treasury', label: t('nav.treasury'), show: has('treasury.read_balances') || has('treasury.read_float') },
    { to: '/reconciliation', label: t('nav.reconciliation'), show: has('reconciliation.read') },
    { to: '/oversight', label: t('nav.oversight'), show: ['oversight.alerts.read', 'oversight.reports', 'oversight.audit', 'oversight.auth_history', 'admin.administrators', 'admin.roles', 'oversight.verify_export'].some(has) },
  ];
  return (
    <>
      <div className={`band ${me.environment}`}>{t(`env.${me.environment}`)}</div>
      <div className="shell">
        <nav className="side">
          <div className="brand">ProxiaPay</div>
          {areas.filter((a) => a.show).map((a) => <NavLink key={a.to} to={a.to} end={a.to === '/'}>{a.label}</NavLink>)}
          <div className="foot">
            {me.administrator.name}<br />
            <span className="muted">{me.administrator.timezone}</span><br />
            <a href="#" onClick={async (e) => { e.preventDefault(); await post('/auth/sign-out'); await refresh(); nav('/sign-in'); }}>{t('nav.sign_out')}</a>
          </div>
        </nav>
        <main>
          <header className="top">
            <form style={{ flex: 1, display: 'flex' }} onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`); }}>
              <input placeholder={t('search.placeholder')} value={q} onChange={(e) => setQ(e.target.value)} />
            </form>
          </header>
          {children}
        </main>
      </div>
    </>
  );
}
