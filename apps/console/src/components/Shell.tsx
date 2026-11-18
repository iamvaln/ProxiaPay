import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { EnvChip, EnvRibbon } from './Environment';
import { Lockup } from './Logo';
import { ClientSwitcher } from './ClientSwitcher';

/** The environment marker (console spec 2) sits above everything and beside the name; areas appear where the administrator holds a permission within them (3.1). */
export function Shell({ children }: { children: React.ReactNode }) {
  const { me, has, refresh } = useSession();
  const t = useT();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  if (!me) return null;
  const client = me.kind === 'client';
  // A session acting as a client (a client account, or a platform account in a partner's view) never sees the platform's areas,
  // whatever else it might hold (the API refuses them anyway).
  const areas = [
    { to: '/', label: t('nav.home'), show: true },
    { to: '/transactions', label: t('nav.transactions'), show: has('transactions.read') },
    { to: '/projects', label: t('nav.projects'), show: has('projects.read') },
    { to: '/configuration', label: t('nav.configuration'), show: !client && (has('reference.read') || has('routes.read') || has('providers.read')) },
    { to: '/treasury', label: t('nav.treasury'), show: !client && (has('treasury.read_balances') || has('treasury.read_float')) },
    { to: '/reconciliation', label: t('nav.reconciliation'), show: !client && has('reconciliation.read') },
    { to: '/oversight', label: t('nav.oversight'), show: !client && ['oversight.alerts.read', 'oversight.reports', 'oversight.audit', 'oversight.auth_history', 'admin.administrators', 'admin.roles', 'admin.clients', 'oversight.verify_export'].some(has) },
    { to: '/team', label: t('nav.team'), show: client && has('client.members') },
    { to: '/account', label: t('nav.account'), show: true },
  ];
  return (
    <>
      <EnvRibbon environment={me.environment} />
      <div className="shell">
        <nav className="side">
          <div className="brand"><Lockup size={22} /><EnvChip environment={me.environment} /></div>
          <ClientSwitcher />
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
