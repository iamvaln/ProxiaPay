import { useNavigate } from 'react-router-dom';
import { post } from '../lib/api';
import { useSession, useT } from '../lib/session';

/** Offered only to someone who belongs to several clients; the session then acts for one of them at a time. */
export function ClientSwitcher() {
  const { me, refresh } = useSession();
  const t = useT();
  const nav = useNavigate();
  if (!me || me.clients.length < 2) return null;
  const switchTo = async (id: string) => {
    await post('/auth/active-client', { client_id: id });
    await refresh();
    nav('/');
  };
  return (
    <label className="small">{t('nav.client')}
      <select value={me.active_client?.id ?? ''} onChange={(e) => void switchTo(e.target.value)}>
        {me.active_client ? null : <option value="" disabled />}
        {me.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}
