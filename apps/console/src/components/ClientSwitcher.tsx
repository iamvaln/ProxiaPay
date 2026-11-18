import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, readableError } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { ErrorLine } from './common';

/** The option that stands for the super-admin view; never a client id, which is a uuid. */
const SUPER_ADMIN = 'super-admin';

/**
 * The session acts for one client at a time. A client account is offered its clients when it has several. A platform
 * account is offered "Super admin" and the partners it belongs to, and always while it works in a partner's view, since
 * switching back here is the only way to the platform again.
 */
export function ClientSwitcher() {
  const { me, refresh } = useSession();
  const t = useT();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const platform = me.account_kind === 'platform';
  if (platform ? me.clients.length === 0 && me.kind !== 'client' : me.clients.length < 2) return null;
  const switchTo = async (value: string) => {
    setError(null);
    try {
      await post('/auth/active-client', { client_id: value === SUPER_ADMIN ? null : value });
      await refresh();
      nav('/');
    } catch (e) { setError(readableError(e, t)); }
  };
  const current = me.kind === 'platform' ? SUPER_ADMIN : (me.active_client?.id ?? '');
  return (
    <>
    <label className="small">{t('nav.client')}
      <select value={current} onChange={(e) => void switchTo(e.target.value)}>
        {current ? null : <option value="" disabled />}
        {platform && <option value={SUPER_ADMIN}>{t('nav.super_admin')}</option>}
        {me.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
    <ErrorLine error={error} />
    </>
  );
}
