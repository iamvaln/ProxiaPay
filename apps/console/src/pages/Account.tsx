import { useState } from 'react';
import { get, post } from '../lib/api';
import { useT } from '../lib/session';
import { Empty, ErrorLine, SubmitForm, useLoad } from '../components/common';

interface SessionRow { id: string; last_seen_at: string; origin_address: string | null; client_description: string | null; revoked_at: string | null }

/** The account page is the same for platform staff and client accounts: one password, one list of sessions. */
export function AccountPage() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { data, error } = useLoad(() => get<{ sessions: SessionRow[]; current: string }>('/auth/sessions'));
  const change = async () => {
    if (next !== confirm) throw new Error(t('account.mismatch'));
    await post('/auth/password', { current_password: current, new_password: next });
    setCurrent(''); setNext(''); setConfirm('');
    return t('account.changed');
  };
  return (
    <>
      <h1>{t('account.title')}</h1>
      <section className="card">
        <h2>{t('account.password')}</h2>
        <SubmitForm onSubmit={change} submitLabel={t('account.password')}>
          <label>{t('account.current')}<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
          <label>{t('account.new')}<input type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
          <p className="small muted">{t('account.hint')}</p>
          <label>{t('account.confirm')}<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
        </SubmitForm>
      </section>
      <section className="card">
        <h2>{t('account.sessions')}</h2>
        <ErrorLine error={error} />
        {data && (data.sessions.length ? (
          <ul className="stack">
            {data.sessions.map((s) => (
              <li key={s.id}>
                {s.client_description ?? '—'}{s.id === data.current && <span className="muted"> · {t('account.session_current')}</span>}
                <span className="small muted"> · {s.origin_address ?? ''} · {s.revoked_at ? t('account.session_revoked') : t('account.session_seen', { when: new Date(s.last_seen_at).toLocaleString() })}</span>
              </li>
            ))}
          </ul>
        ) : <Empty />)}
      </section>
    </>
  );
}
