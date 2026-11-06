import { useEffect, useRef, useState } from 'react';
import { ApiError, api, requestConfirmation } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { moneyParts, utc, when } from '../lib/format';
import { STATE_SYMBOL, stateFamily, type StateFamily } from '../lib/states';

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = () => { setLoading(true); loader().then((d) => { setData(d); setError(null); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  return { data, error, loading, reload };
}

/** A badge in one state family: its colour, its symbol (decorative) and the word. A plain tag has no symbol. */
export function Tag({ family, children, title }: { family: StateFamily; children: React.ReactNode; title?: string }) {
  if (family === 'tag') return <span className="tag" title={title}>{children}</span>;
  return <span className={`tag ${family}`} title={title}><span className="tag-symbol" aria-hidden="true">{STATE_SYMBOL[family]}</span>{children}</span>;
}

/** Runs fn every ms while the tab is visible, and once more when it becomes visible again. */
export function useEvery(fn: () => void, ms: number): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
    const sync = () => {
      stop();
      if (document.visibilityState === 'visible') { latest.current(); timer = setInterval(() => latest.current(), ms); }
    };
    // The caller loaded once on mount; only a return to the tab triggers an extra run.
    if (document.visibilityState === 'visible') timer = setInterval(() => latest.current(), ms);
    document.addEventListener('visibilitychange', sync);
    return () => { stop(); document.removeEventListener('visibilitychange', sync); };
  }, [ms]);
}

export function Pill({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return <Tag family={stateFamily(value)}>{value.replace(/_/g, ' ')}</Tag>;
}

export function Amount({ minor, currency }: { minor: number | null | undefined; currency: string }) {
  const { lang } = useSession();
  const p = moneyParts(minor, currency, lang);
  return (
    <span className={minor != null && minor < 0 ? 'amount negative' : 'amount'}>
      <span className="amount-figure">{p.figure}</span>{p.currency && <> <span className="amount-currency">{p.currency}</span></>}
    </span>
  );
}

/** Timestamps in the administrator's zone, the UTC value on hover (console spec 3.3). */
export function When({ value }: { value: string | Date | null | undefined }) {
  const { lang, me } = useSession();
  return <span className="when" title={utc(value)}>{when(value, lang, me?.administrator.timezone)}</span>;
}

export function ErrorLine({ error }: { error: string | null | undefined }) {
  return error ? <p className="error">{error}</p> : null;
}

export function Empty({ text }: { text?: string }) {
  const t = useT();
  return <p className="muted">{text ?? t('common.none')}</p>;
}

export function ScopeNote({ scoped }: { scoped?: boolean }) {
  const t = useT();
  return scoped ? <p className="small muted">{t('common.scoped')}</p> : null;
}

export function NeedsPermission({ permission }: { permission: string }) {
  const t = useT();
  return <span className="small muted">{t('common.permission_needed', { permission })}</span>;
}

/** What the administrator reads once an operation commits: sent for approval, or done. */
export function committedMessage(result: unknown, t: (key: string) => string): string {
  return (result as { status?: string } | null)?.status === 'pending_approval' ? t('common.sent_for_approval') : t('common.done');
}

/**
 * The confirmation pattern of console spec 11.1: the screen shows what will happen, a code is
 * requested, entered, and the operation commits. The code is bound to the submitted values.
 * `done` words the outcome; it is read with the values as they were committed.
 */
export function ConfirmedAction({ operationType, values, path, method = 'POST', label, summary, onDone, done, disabled, subject }: {
  operationType: string; values: Record<string, unknown>; path: string; method?: 'POST' | 'PUT' | 'DELETE' | 'PATCH'; label: string; summary?: React.ReactNode; onDone?: (result: unknown) => void; done?: (result: unknown) => string; disabled?: boolean; subject?: string;
}) {
  const t = useT();
  const [stage, setStage] = useState<'idle' | 'code' | 'busy'>('idle');
  const [confirmationId, setConfirmationId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<string | null>(null);
  const begin = async () => {
    setError(null); setCommitted(null); setStage('busy');
    try { const c = await requestConfirmation(operationType, values, subject); setConfirmationId(c.confirmation_id); setStage('code'); } catch (e) { setError((e as Error).message); setStage('idle'); }
  };
  const commit = async () => {
    setError(null); setStage('busy');
    try {
      const r = await api(path.replace(/^\/console/, ''), { method, body: { ...values, confirmation: { id: confirmationId, code } } });
      setCommitted(done?.(r) ?? committedMessage(r, t)); setStage('idle'); setCode(''); onDone?.(r);
    } catch (e) {
      const err = e as ApiError;
      setError(err.details?.attempts_remaining !== undefined ? `${err.message} (${err.details.attempts_remaining} attempts left)` : err.message);
      setStage(err.code === 'CONFIRMATION_INVALID' && !err.details?.exhausted ? 'code' : 'idle');
    }
  };
  return (
    <div>
      {summary}
      {stage === 'idle' && <button className="primary" disabled={disabled} onClick={begin}>{label}</button>}
      {stage === 'busy' && <button disabled>…</button>}
      {stage === 'code' && (
        <div className="row">
          <span className="small">{t('common.code_prompt')}</span>
          <input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ width: 90 }} />
          <button className="primary" disabled={code.length !== 6} onClick={commit}>{t('common.confirm')}</button>
          <button onClick={() => { setStage('idle'); setCode(''); }}>{t('common.cancel')}</button>
        </div>
      )}
      <ErrorLine error={error} />
      {committed && <p className="ok" role="status">✓ {committed}</p>}
    </div>
  );
}
