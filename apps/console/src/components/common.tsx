import { useEffect, useState } from 'react';
import { ApiError, post, requestConfirmation } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { money, utc, when } from '../lib/format';

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = () => { setLoading(true); loader().then((d) => { setData(d); setError(null); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  return { data, error, loading, reload };
}

export function Pill({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return <span className={`pill ${value}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Amount({ minor, currency }: { minor: number | null | undefined; currency: string }) {
  const { lang } = useSession();
  return <span className={minor != null && minor < 0 ? 'negative' : ''}>{money(minor, currency, lang)}</span>;
}

/** Timestamps in the administrator's zone, the UTC value on hover (console spec 3.3). */
export function When({ value }: { value: string | Date | null | undefined }) {
  const { lang, me } = useSession();
  return <span title={utc(value)}>{when(value, lang, me?.administrator.timezone)}</span>;
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

/**
 * The confirmation pattern of console spec 11.1: the screen shows what will happen, a code is
 * requested, entered, and the operation commits. The code is bound to the submitted values.
 */
export function ConfirmedAction({ operationType, values, path, method = 'POST', label, summary, onDone, disabled, subject }: {
  operationType: string; values: Record<string, unknown>; path: string; method?: 'POST' | 'PUT' | 'DELETE' | 'PATCH'; label: string; summary?: React.ReactNode; onDone?: (result: unknown) => void; disabled?: boolean; subject?: string;
}) {
  const t = useT();
  const [stage, setStage] = useState<'idle' | 'code' | 'busy'>('idle');
  const [confirmationId, setConfirmationId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const begin = async () => {
    setError(null); setStage('busy');
    try { const c = await requestConfirmation(operationType, values, subject); setConfirmationId(c.confirmation_id); setStage('code'); } catch (e) { setError((e as Error).message); setStage('idle'); }
  };
  const commit = async () => {
    setError(null); setStage('busy');
    try {
      const r = await post(path.replace(/^\/console/, ''), { ...values, confirmation: { id: confirmationId, code } });
      setResult(r); setStage('idle'); setCode(''); onDone?.(r);
    } catch (e) {
      const err = e as ApiError;
      setError(err.details?.attempts_remaining !== undefined ? `${err.message} (${err.details.attempts_remaining} attempts left)` : err.message);
      setStage(err.code === 'CONFIRMATION_INVALID' && !err.details?.exhausted ? 'code' : 'idle');
    }
  };
  void method;
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
      {result != null && <details><summary>Result</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}
    </div>
  );
}
