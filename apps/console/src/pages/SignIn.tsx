import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, get, post } from '../lib/api';
import { useSession, useT, type Me } from '../lib/session';
import type { Lang } from '../lib/i18n';
import { QrCode } from '../components/QrCode';
import { Lockup } from '../components/Logo';
import { EnvChip, EnvRibbon, LanguageSwitch } from '../components/Environment';

/** Sign-in (console spec 4.1): the language is offered before authentication; failures name neither field. */
export function SignInPage() {
  const { refresh, lang, setLang, me } = useSession();
  const t = useT();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  // Only an in-console path is honoured, never another origin.
  const back = from && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/sign-in') ? from : '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'credentials' | 'verify' | 'enrol'>(me && !me.second_factor_complete ? 'verify' : 'credentials');
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [environment, setEnvironment] = useState<Me['environment'] | null>(null);
  // The environment is shown before anyone signs in (console spec 2); until it answers, nothing is claimed.
  useEffect(() => { get<{ environment: Me['environment'] }>('/auth/environment').then((r) => setEnvironment(r.environment)).catch(() => undefined); }, []);

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
    try { await post('/auth/second-factor', { code }); await refresh(); nav(back); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
    <EnvRibbon environment={environment} />
    <div className="signin-page">
      <header className="signin-head">
        <h1><Lockup size={32} /></h1>
        <p className="muted">{t('signin.console')}</p>
        <EnvChip environment={environment} />
      </header>
      <div className="signin card">
        {stage === 'credentials' && (
          <form className="stack" onSubmit={signIn}>
            <h2>{t('signin.title')}</h2>
            <label>{t('signin.email')}<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>{t('signin.password')}<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            {error && <p className="error">{error}</p>}
            {locked && <p className="error">{t('signin.locked', { until: new Date(locked).toLocaleTimeString() })}</p>}
            <button className="primary" disabled={busy}>{t('signin.submit')}</button>
            {/* No reset link until the platform can send one (console spec 4.1); until then, say who can help. */}
            <p className="small muted">{t('signin.forgot')}</p>
          </form>
        )}
        {(stage === 'verify' || stage === 'enrol') && (
          <form className="stack" onSubmit={verify}>
            <h2>{t('second.title')}</h2>
            {stage === 'enrol' && enrol && (
              <div>
                <p className="small">{t('second.enrol')}</p>
                <QrCode value={enrol.uri} alt={t('second.enrol_qr_alt')} />
                <p className="small muted">{t('second.enrol_manual')}</p>
                <pre>{enrol.secret}</pre>
              </div>
            )}
            <label>{t('second.code')}<input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /></label>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy || code.length !== 6}>{t('second.verify')}</button>
          </form>
        )}
        <LanguageSwitch lang={lang} onChange={(l: Lang) => setLang(l)} />
      </div>
    </div>
    </>
  );
}
