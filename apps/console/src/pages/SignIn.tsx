import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import type { Lang } from '../lib/i18n';

/** Sign-in (console spec 4.1): the language is offered before authentication; failures name neither field. */
export function SignInPage() {
  const { refresh, lang, setLang, me } = useSession();
  const t = useT();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'credentials' | 'verify' | 'enrol'>(me && !me.second_factor_complete ? 'verify' : 'credentials');
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setLocked(null); setBusy(true);
    try {
      const r = await post<{ second_factor?: 'verify' | 'enrol'; locked?: boolean; locked_until?: string }>('/auth/sign-in', { email, password, language: lang });
      if (r.locked) { setLocked(r.locked_until!); return; }
      if (r.second_factor === 'enrol') { setEnrol(await post('/auth/second-factor/enrol')); setStage('enrol'); } else setStage('verify');
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'CREDENTIALS_INVALID' ? t('signin.mismatch') : (err as Error).message);
    } finally { setBusy(false); }
  };
  const verify = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setBusy(true);
    try { await post('/auth/second-factor', { code }); await refresh(); nav('/'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="signin card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>ProxiaPay</h1>
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}><option value="en">English</option><option value="fr">Français</option></select>
      </div>
      {stage === 'credentials' && (
        <form className="stack" onSubmit={signIn}>
          <h2>{t('signin.title')}</h2>
          <label>{t('signin.email')}<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>{t('signin.password')}<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <p className="error">{error}</p>}
          {locked && <p className="error">{t('signin.locked', { until: new Date(locked).toLocaleTimeString() })}</p>}
          <button className="primary" disabled={busy}>{t('signin.submit')}</button>
          <a href="#" className="small" onClick={(e) => { e.preventDefault(); setResetSent(true); }}>{t('signin.reset')}</a>
          {resetSent && <p className="small muted">{t('signin.reset_sent')}</p>}
        </form>
      )}
      {(stage === 'verify' || stage === 'enrol') && (
        <form className="stack" onSubmit={verify}>
          <h2>{t('second.title')}</h2>
          {stage === 'enrol' && enrol && (
            <div>
              <p className="small">{t('second.enrol')}</p>
              <pre>{enrol.secret}</pre>
              <p className="small muted" style={{ wordBreak: 'break-all' }}>{enrol.uri}</p>
            </div>
          )}
          <label>{t('second.code')}<input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /></label>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy || code.length !== 6}>{t('second.verify')}</button>
        </form>
      )}
    </div>
  );
}
