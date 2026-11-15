import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { SubmitForm } from '../components/common';
import { Lockup } from '../components/Logo';
import { LanguageSwitch } from '../components/Environment';

/** Public: opened from the emailed link, before any session. A dead link says one neutral thing, whatever made it dead. */
export function InvitationPage() {
  const { token = '' } = useParams();
  const { lang, setLang } = useSession();
  const t = useT();
  const nav = useNavigate();
  const [invitation, setInvitation] = useState<{ client_name: string; sets_password: boolean } | null>(null);
  const [dead, setDead] = useState(false);
  const [password, setPassword] = useState('');
  useEffect(() => { get<{ client_name: string; sets_password: boolean }>(`/invitations/${encodeURIComponent(token)}`).then(setInvitation).catch(() => setDead(true)); }, [token]);

  const accept = async () => {
    await post(`/invitations/${encodeURIComponent(token)}`, invitation!.sets_password ? { password } : {});
    nav('/sign-in');
  };
  const title = invitation ? (invitation.sets_password ? t('invitation.set_password') : t('invitation.join', { client: invitation.client_name })) : '';
  return (
    <div className="signin-page">
      <header className="signin-head"><h1><Lockup size={32} /></h1></header>
      <div className="signin card">
        {dead && <p className="error">{t('invitation.invalid')}</p>}
        {!dead && !invitation && <p className="muted">…</p>}
        {invitation && (
          <>
            <h2>{title}</h2>
            <p className="small">{t('invitation.for', { client: invitation.client_name })}</p>
            <SubmitForm onSubmit={accept} submitLabel={title}>
              {invitation.sets_password && (
                <>
                  <label>{t('signin.password')}<input type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
                  <p className="small muted">{t('account.hint')}</p>
                </>
              )}
            </SubmitForm>
          </>
        )}
        <LanguageSwitch lang={lang} onChange={setLang} />
      </div>
    </div>
  );
}
