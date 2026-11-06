import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/session';

/** Copies one value; the button says "Copied" for two seconds, or asks for a manual copy when the browser refuses. */
function CopyButton({ value }: { value: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(value); setState('copied'); } catch { setState('failed'); }
    timer.current = setTimeout(() => setState('idle'), 2000);
  };
  return (
    <>
      <button type="button" onClick={copy}>{state === 'copied' ? t('secret.copied') : t('secret.copy')}</button>
      {state === 'failed' && <span className="small negative">{t('secret.copy_failed')}</span>}
    </>
  );
}

/**
 * Values the platform shows once, where they were made: each with its label, its own Copy button, and one
 * acknowledgement that hides the panel. Nothing else replaces it; it stays until dismissed.
 */
export function SecretOnce({ items, onDismiss }: { items: { label: string; value: string }[]; onDismiss: () => void }) {
  const t = useT();
  return (
    <div className="warnbox secret-once">
      <p>{t('secret.once')}</p>
      {items.map((i) => (
        <div className="row" key={i.label}>
          <span className="small">{i.label}</span>
          <code className="mono secret-value">{i.value}</code>
          <CopyButton value={i.value} />
        </div>
      ))}
      <button type="button" className="primary" onClick={onDismiss}>{t('secret.dismiss')}</button>
    </div>
  );
}
