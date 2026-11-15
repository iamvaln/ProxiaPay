import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Mark } from '../components/Logo';
import { confirmPayment, createPreview, getLink, getPayment, PayError, quote as fetchQuote, sendReceipt, type LinkView, type PaymentStatus, type Quote, type Review } from './api';
import { detectCountry } from './country';
import { countryName, detectLanguage, money, parseAmount, t, type Key, type Lang } from './i18n';

/**
 * The page a payer opens from a payment link (spec: payment links, the page): the link's form, the review of the total,
 * the request sent to the payer's phone, and the outcome. It types nothing after confirming: the operator asks the payer,
 * and the page follows the payment until the outcome is in.
 */

export interface PayTimings {
  /** How often the page asks for the payment's state in the first minute, then after it. */
  pollFast: number; pollSlow: number; slowAfter: number;
  /** How long the payer pauses typing an amount before the page prices it. */
  quoteDelay: number;
}
const TIMINGS: PayTimings = { pollFast: 3000, pollSlow: 10_000, slowAfter: 60_000, quoteDelay: 400 };

/** Often while the payer is likely holding their phone, then gently: an approval rarely takes more than a minute. */
export const pollDelay = (elapsed: number, tm: PayTimings = TIMINGS): number => (elapsed < tm.slowAfter ? tm.pollFast : tm.pollSlow);

/** The paylink host serves this page for every path: the first segment is the link's code. */
export const codeFromPath = (pathname: string): string => pathname.split('/').filter(Boolean)[0] ?? '';

/** The payment token is kept in the fragment only (never sent to a server, never in a cookie), so a reload follows the same payment. */
const HASH = /^#p=([A-Za-z0-9_-]{43})$/;
const tokenFromHash = (): string | null => HASH.exec(window.location.hash)?.[1] ?? null;
function keepToken(token: string | null): void {
  window.history.replaceState(null, '', token ? `#p=${token}` : window.location.pathname + window.location.search);
}

type Stage =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'load-failed'; error: unknown }
  | { kind: 'form' }
  | { kind: 'review'; token: string; review: Review }
  | { kind: 'following'; token: string; review: Review | null; status: PaymentStatus | null };

/** What the payer reads when a call fails: the page words what it knows in their language, otherwise the API's own plain message. */
function describe(e: unknown, lang: Lang): string {
  const say = (key: Key) => t(lang, key);
  if (!(e instanceof PayError)) return say('error.network');
  if (e.status === 429 || e.code === 'RATE_LIMITED') return say('error.rate_limited');
  switch (e.code) {
    case 'PREVIEW_EXPIRED': return say('error.total_expired');
    case 'SIMILAR_PAYMENT_PENDING': return say('error.number_pending');
    case 'NO_PROVIDER_AVAILABLE': case 'FLOAT_INSUFFICIENT': return say('error.method_down');
    case 'VELOCITY_COUNT_EXCEEDED': case 'VELOCITY_VALUE_EXCEEDED': return say('error.link_busy');
    case 'NOT_FOUND': return say('error.payment_gone');
    case 'CONFLICT':
      if (e.message.startsWith('A payment is already in progress')) return say('error.in_progress');
      if (e.message.startsWith('A payment on this link is being checked')) return say('error.being_checked');
      return e.message;
  }
  return e.status >= 500 || !e.message ? say('error.generic') : e.message;
}

const FINAL_FAILURES = new Set(['failed', 'expired']);

export function PayApp({ timings }: { timings?: Partial<PayTimings> }) {
  const tm: PayTimings = { ...TIMINGS, ...timings };
  const [lang, setLang] = useState<Lang>(() => detectLanguage());
  const [code] = useState(() => codeFromPath(window.location.pathname));
  const [link, setLink] = useState<LinkView | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [country, setCountry] = useState('');
  const [methodKey, setMethodKey] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [amountText, setAmountText] = useState('');
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);

  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { if (link) document.title = `${link.title} · ${link.project_name}`; }, [link]);

  /** Reads the link again; a method the page offered may have gone, so the selection follows what is still on offer. */
  const refreshLink = useCallback(async (): Promise<LinkView | null> => {
    try {
      const view = await getLink(code);
      setLink(view);
      return view;
    } catch {
      return null;
    }
  }, [code]);

  const load = useCallback(async () => {
    setStage({ kind: 'loading' });
    const token = tokenFromHash();
    try {
      const view = await getLink(code);
      setLink(view);
      const chosen = detectCountry(view.countries.map((c) => c.code));
      setCountry(chosen);
      setMethodKey(view.methods.find((m) => m.country === chosen)?.key ?? '');
      setStage(token ? { kind: 'following', token, review: null, status: null } : { kind: 'form' });
    } catch (e) {
      // A paid single-use link is no longer available, yet its payer may reload the receipt: the token still follows it.
      if (token && e instanceof PayError && e.status === 404) setStage({ kind: 'following', token, review: null, status: null });
      else if (e instanceof PayError && e.status === 404) setStage({ kind: 'unavailable' });
      else setStage({ kind: 'load-failed', error: e });
    }
  }, [code]);
  useEffect(() => { void load(); }, [load]);

  // Follows the payment: every few seconds, then less often, until its outcome is in. A change of language reads it again.
  const followToken = stage.kind === 'following' ? stage.token : null;
  useEffect(() => {
    if (!followToken) return;
    const started = Date.now();
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const status = await getPayment(followToken, lang);
        if (!live) return;
        setStage((s) => (s.kind === 'following' && s.token === followToken ? { ...s, status } : s));
        if (status.outcome) return;
      } catch (e) {
        if (!live) return;
        // Unknown, never confirmed, or past its day: the payer starts over from the link.
        if (e instanceof PayError && e.status === 404) {
          keepToken(null);
          setStage(link ? { kind: 'form' } : { kind: 'unavailable' });
          return;
        }
      }
      timer = setTimeout(() => { void tick(); }, pollDelay(Date.now() - started, tm));
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followToken, lang]);

  /** Keeps the payer's method when the link still offers it; otherwise the country's first, or the link's first. */
  function keepOffered(view: LinkView): void {
    if (view.methods.some((m) => m.key === methodKey)) return;
    const next = view.methods.find((m) => m.country === country) ?? view.methods[0];
    setCountry(next?.country ?? '');
    setMethodKey(next?.key ?? '');
  }

  const brandStyle = link ? ({ '--pay-primary': link.brand.primary_color } as CSSProperties) : undefined;
  const succeeded = stage.kind === 'following' && stage.status?.state === 'succeeded';

  let body: ReactNode;
  switch (stage.kind) {
    case 'loading':
      body = <p className="pay-muted" role="status">{say('page.loading')}</p>;
      break;
    case 'unavailable':
      body = <Notice title={say('page.unavailable')}>{say('page.unavailable_hint')}</Notice>;
      break;
    case 'load-failed':
      body = (
        <Notice title={stage.error instanceof PayError && stage.error.status === 429 ? say('error.rate_limited') : say('page.load_failed')}>
          <button type="button" className="pay-button" onClick={() => { void load(); }}>{say('page.retry')}</button>
        </Notice>
      );
      break;
    case 'form':
      body = link && (
        <PayForm
          link={link} lang={lang} timings={tm} country={country} methodKey={methodKey} msisdn={msisdn} amountText={amountText}
          onCountry={(c) => { setCountry(c); setMethodKey(link.methods.find((m) => m.country === c)?.key ?? ''); }}
          onMethod={setMethodKey} onMsisdn={setMsisdn} onAmount={setAmountText}
          onUnavailable={() => setStage({ kind: 'unavailable' })}
          onMethodGone={async () => {
            const view = await refreshLink();
            if (view) keepOffered(view);
          }}
          onReview={(token, review) => setStage({ kind: 'review', token, review })}
        />
      );
      break;
    case 'review':
      body = link && (
        <ReviewStep
          link={link} lang={lang} review={stage.review} token={stage.token}
          onEdit={() => { keepToken(null); setStage({ kind: 'form' }); }}
          onUnavailable={() => { keepToken(null); setStage({ kind: 'unavailable' }); }}
          onConfirmed={() => setStage({ kind: 'following', token: stage.token, review: stage.review, status: null })}
        />
      );
      break;
    case 'following': {
      const { status, review, token } = stage;
      if (!status) body = <p className="pay-muted" role="status">{say('page.loading')}</p>;
      else if (status.state === 'succeeded') body = <Receipt link={link} lang={lang} status={status} review={review} token={token} />;
      else if (FINAL_FAILURES.has(status.state)) {
        body = (
          <Failure
            lang={lang} status={status} checkLink={refreshLink}
            onRetry={() => {
              keepToken(null);
              // The link was just read again: keep the payer's method if it is still offered, else the country's first.
              if (link) keepOffered(link);
              setStage({ kind: 'form' });
            }}
          />
        );
      } else if (status.state === 'undetermined') body = <Notice title={say('checking.title')}>{say('checking.body')}<Reference lang={lang} reference={status.reference} /></Notice>;
      else body = <Waiting lang={lang} status={status} review={review} exponent={link?.exponent ?? guessExponent(status.currency)} />;
      break;
    }
  }

  return (
    <div className="pay-page" style={brandStyle}>
      {link?.sandbox && <div className="pay-band">{say('page.sandbox')}</div>}
      <div className="pay-wrap">
        <div className="pay-top">
          <div className="pay-lang" role="group" aria-label={say('page.language')}>
            {(['fr', 'en'] as const).map((l) => (
              <button key={l} type="button" lang={l} aria-pressed={lang === l} className={lang === l ? 'on' : undefined} onClick={() => setLang(l)}>
                {l === 'fr' ? 'Français' : 'English'}
              </button>
            ))}
          </div>
        </div>
        <div className="pay-card">
          <Panel link={link} lang={lang} succeeded={succeeded} />
          <section className="pay-main">{body}</section>
        </div>
        <footer className="pay-footer">
          <span>{say('page.powered')}</span>
          <span className="pay-lockup"><Mark size={16} /> ProxiaPay</span>
        </footer>
      </div>
    </div>
  );
}

/** The client's side of the card: their logo, name and link; on success, the thanks. */
function Panel({ link, lang, succeeded }: { link: LinkView | null; lang: Lang; succeeded: boolean }) {
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  return (
    <aside className="pay-panel">
      {link && (
        <div className="pay-brand">
          {link.brand.logo_url
            ? <img className="pay-logo" src={link.brand.logo_url} alt="" />
            : <span className="pay-logo pay-initial" aria-hidden="true">{link.project_name.trim().charAt(0).toUpperCase()}</span>}
          <span className="pay-project">{link.project_name}</span>
        </div>
      )}
      {succeeded ? (
        <div className="pay-intro">
          <span className="pay-check" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg></span>
          <h1>{say('success.title')}</h1>
          {link && <p>{say('success.thanks', { project: link.project_name })}</p>}
        </div>
      ) : link && (
        <div className="pay-intro">
          <h1>{link.title}</h1>
          {link.description && <p>{link.description}</p>}
          <p className="pay-panel-amount">{link.amount_type === 'fixed' && link.amount !== null ? money(link.amount, link.currency, link.exponent, lang) : say('page.amount_free')}</p>
        </div>
      )}
      <p className="pay-secure">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        <span>{say('page.secure')}</span>
      </p>
    </aside>
  );
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pay-notice" role="status">
      <h2>{title}</h2>
      {children && <div className="pay-notice-body">{children}</div>}
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p className="pay-error" id={id}>{message}</p> : null;
}

type FieldErrors = { amount?: string; method?: string; msisdn?: string; form?: unknown };

function PayForm(props: {
  link: LinkView; lang: Lang; timings: PayTimings; country: string; methodKey: string; msisdn: string; amountText: string;
  onCountry: (c: string) => void; onMethod: (k: string) => void; onMsisdn: (v: string) => void; onAmount: (v: string) => void;
  onUnavailable: () => void; onMethodGone: () => Promise<void>; onReview: (token: string, review: Review) => void;
}) {
  const { link, lang, country, methodKey, msisdn, amountText } = props;
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  const fmt = (minor: number) => money(minor, link.currency, link.exponent, lang);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [amountTouched, setAmountTouched] = useState(false);
  const [quoted, setQuoted] = useState<{ quote?: Quote; error?: unknown } | null>(null);

  const free = link.amount_type === 'free';
  const methods = link.methods.filter((m) => m.country === country);
  const method = link.methods.find((m) => m.key === methodKey) ?? null;
  const place = link.countries.find((c) => c.code === country);
  const amount = free ? parseAmount(amountText, link.exponent) : link.amount;
  const floor = method?.minimum_amount ?? link.minimum_amount;
  const localAmountError = !free ? undefined
    : amount === null ? say('form.amount_invalid')
      : amount < floor ? say('form.amount_min', { amount: fmt(floor) })
        : method && amount > method.maximum_amount ? say('form.amount_max', { amount: fmt(method.maximum_amount) }) : undefined;

  // A free amount is priced as the payer types, once they pause; an amount the page can already refuse is not sent.
  const quotable = free && method && amount !== null && !localAmountError ? `${method.key}:${amount}` : null;
  useEffect(() => {
    setQuoted(null);
    if (!quotable || !method || amount === null) return;
    let live = true;
    const timer = setTimeout(() => {
      fetchQuote(link.code, method.key, amount).then(
        (q) => { if (live) setQuoted({ quote: q }); },
        (e: unknown) => { if (live) setQuoted({ error: e }); },
      );
    }, props.timings.quoteDelay);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotable]);

  if (link.methods.length === 0) return <Notice title={say('page.no_methods')} />;

  const quoteError = quoted?.error instanceof PayError && quoted.error.field === 'amount' ? quoted.error.message : quoted?.error ? describe(quoted.error, lang) : undefined;
  // A figure being typed is not judged until the payer leaves the field or continues; the minimum stays in view meanwhile.
  const amountError = errors.amount ?? (amountTouched ? localAmountError : undefined) ?? quoteError;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!method || busy) return;
    if (free) {
      setAmountTouched(true);
      if (localAmountError || amount === null) return;
    }
    setBusy(true);
    setErrors({});
    try {
      const r = await createPreview(link.code, { method: method.key, msisdn, ...(free ? { amount: amount! } : {}) });
      props.onReview(r.payment_token, r.review);
    } catch (err) {
      if (err instanceof PayError && err.code === 'LINK_UNAVAILABLE') { props.onUnavailable(); return; }
      if (err instanceof PayError && err.status !== 429 && (err.field === 'amount' || err.field === 'msisdn' || err.field === 'method')) {
        setErrors({ [err.field]: err.message });
        if (err.field === 'method') void props.onMethodGone();
      } else {
        setErrors({ form: err });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="pay-form" onSubmit={submit} noValidate>
      <h2>{say('form.title')}</h2>
      {free && (
        <div className="pay-field">
          <label htmlFor="pay-amount">{say('form.amount', { currency: link.currency })}</label>
          <input
            id="pay-amount" className="pay-amount" inputMode="decimal" autoComplete="off" value={amountText}
            aria-invalid={amountError ? true : undefined} aria-describedby="pay-amount-hint pay-amount-error"
            onChange={(e) => { props.onAmount(e.target.value); setErrors((x) => ({ ...x, amount: undefined })); }}
            onBlur={() => setAmountTouched(amountText.trim() !== '')}
          />
          <p className="pay-hint" id="pay-amount-hint">
            {quoted?.quote && amount !== null
              ? say('form.quote', { fees: fmt(quoted.quote.fees_borne_by_payer), total: fmt(quoted.quote.charged_amount) })
              : floor > 0 ? say('form.minimum', { amount: fmt(floor) }) : null}
          </p>
          <FieldError id="pay-amount-error" message={amountError} />
        </div>
      )}
      <div className={link.countries.length >= 2 ? 'pay-pair' : undefined}>
        {link.countries.length >= 2 && (
          <div className="pay-field">
            <label htmlFor="pay-country">{say('form.country')}</label>
            <select id="pay-country" value={country} onChange={(e) => props.onCountry(e.target.value)}>
              {link.countries.map((c) => <option key={c.code} value={c.code}>{countryName(c.code, c.name, lang)}</option>)}
            </select>
          </div>
        )}
        <div className="pay-field">
          <label htmlFor="pay-method">{say('form.method')}</label>
          <select
            id="pay-method" value={methodKey} aria-describedby="pay-method-error"
            onChange={(e) => { props.onMethod(e.target.value); setErrors((x) => ({ ...x, method: undefined })); }}
          >
            {methods.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
          </select>
          <FieldError id="pay-method-error" message={errors.method} />
        </div>
      </div>
      {!free && method?.charged_amount !== undefined && (
        <p className="pay-hint">{say('form.total', { operator: method.name, total: fmt(method.charged_amount) })}</p>
      )}
      <div className="pay-field">
        <label htmlFor="pay-msisdn">{say('form.number', { operator: method?.name ?? '' })}</label>
        <div className="pay-phone">
          {place && <span className="pay-prefix">{place.dialling_prefix}</span>}
          <input
            id="pay-msisdn" type="tel" inputMode="tel" autoComplete="tel-national" value={msisdn}
            aria-invalid={errors.msisdn ? true : undefined} aria-describedby="pay-msisdn-error"
            onChange={(e) => { props.onMsisdn(e.target.value); setErrors((x) => ({ ...x, msisdn: undefined })); }}
          />
        </div>
        <FieldError id="pay-msisdn-error" message={errors.msisdn} />
      </div>
      {errors.form !== undefined && <p className="pay-error pay-form-error" role="alert">{describe(errors.form, lang)}</p>}
      <button type="submit" className="pay-button pay-push" disabled={busy || !method}>{busy ? say('form.wait') : say('form.continue')}</button>
    </form>
  );
}

function ReviewStep({ link, lang, review, token, onEdit, onUnavailable, onConfirmed }: {
  link: LinkView; lang: Lang; review: Review; token: string; onEdit: () => void; onUnavailable: () => void; onConfirmed: () => void;
}) {
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  const fmt = (minor: number) => money(minor, review.currency, link.exponent, lang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const minutes = Math.max(1, Math.round((Date.parse(review.expires_at) - Date.now()) / 60_000));
  const place = link.countries.find((c) => c.code === review.method.country);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    // In the fragment before the call: should the page reload while the operator is being asked, it still follows the payment.
    keepToken(token);
    try {
      await confirmPayment(token);
      onConfirmed();
    } catch (e) {
      if (e instanceof PayError) {
        keepToken(null);
        if (e.code === 'LINK_UNAVAILABLE') { onUnavailable(); return; }
      }
      // A network failure leaves the token: confirming again returns the same payment if the first one went through.
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pay-form">
      <h2>{say('review.title')}</h2>
      <dl className="pay-summary">
        <dt>{say('review.amount')}</dt><dd>{fmt(review.amount)}</dd>
        <dt>{say('review.fees', { operator: review.method.name })}</dt><dd>{fmt(review.fees_borne_by_payer)}</dd>
        <dt>{say('review.method')}</dt><dd>{review.method.name} · {countryName(review.method.country, place?.name ?? review.method.country, lang)}</dd>
        <dt>{say('review.number')}</dt><dd>{review.msisdn_formatted}</dd>
        <dt className="pay-total">{say('review.total')}</dt><dd className="pay-total">{fmt(review.total)}</dd>
      </dl>
      <p className="pay-hint">
        {say('review.holds', { duration: minutes === 1 ? say('review.minute') : say('review.minutes', { n: minutes }), operator: review.method.name })}
      </p>
      {error !== undefined && <p className="pay-error pay-form-error" role="alert">{describe(error, lang)}</p>}
      <div className="pay-actions pay-push">
        <button type="button" className="pay-button pay-secondary" onClick={onEdit} disabled={busy}>{say('review.edit')}</button>
        <button type="button" className="pay-button pay-grow" onClick={() => { void confirm(); }} disabled={busy}>
          {busy ? say('form.wait') : say('review.confirm', { total: fmt(review.total) })}
        </button>
      </div>
    </div>
  );
}

function Waiting({ lang, status, review, exponent }: { lang: Lang; status: PaymentStatus; review: Review | null; exponent: number }) {
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  const operator = status.method.name;
  return (
    <div className="pay-form" aria-live="polite">
      <div className="pay-heading">
        <svg className="pay-accent" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></svg>
        <h2>{say('sent.title')}</h2>
      </div>
      <p>{review ? say('sent.body', { number: review.msisdn_formatted, operator }) : say('sent.body_phone', { operator })}</p>
      <p className="pay-hint">{say('sent.total', { total: money(status.charged_amount, status.currency, exponent, lang) })}</p>
      {status.instructions && (
        <div className="pay-instructions">
          <strong>{operator} · {countryName(status.method.country, status.method.country, lang)}</strong>
          <p>{status.instructions}</p>
        </div>
      )}
      <div className="pay-waiting" role="status">
        <svg className="pay-spinner pay-accent" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>
        <span>{say('sent.waiting')}</span>
      </div>
      <p className="pay-hint pay-push">{say('sent.nothing')}</p>
    </div>
  );
}

/** Only for a reloaded receipt whose link is gone: the status carries no exponent, and a link's currencies are few and fixed. */
const EXPONENTS: Record<string, number> = { XAF: 0, XOF: 0, GNF: 0, CDF: 2, USD: 2 };
const guessExponent = (currency: string): number => EXPONENTS[currency] ?? 2;

function Reference({ lang, reference }: { lang: Lang; reference: string }) {
  return <p className="pay-hint">{t(lang, 'receipt.reference')} <span className="pay-mono">{reference}</span></p>;
}

function Failure({ lang, status, checkLink, onRetry }: { lang: Lang; status: PaymentStatus; checkLink: () => Promise<LinkView | null>; onRetry: () => void }) {
  const say = (key: Key) => t(lang, key);
  const [usable, setUsable] = useState<boolean | null>(null);
  // "Try again" only when the link still takes payments: a link that expired or was disabled meanwhile says so instead.
  useEffect(() => {
    let live = true;
    void checkLink().then((view) => { if (live) setUsable(!!view && view.methods.length > 0); });
    return () => { live = false; };
  }, [checkLink]);
  return (
    <div className="pay-form">
      <h2>{say('failed.title')}</h2>
      <p>{status.outcome?.failure_reason_text ?? say('failed.generic')}</p>
      <Reference lang={lang} reference={status.reference} />
      {usable === true && <button type="button" className="pay-button pay-push" onClick={onRetry}>{say('failed.retry')}</button>}
      {usable === false && <p className="pay-hint">{say('failed.closed')}</p>}
    </div>
  );
}

function Receipt({ link, lang, status, review, token }: { link: LinkView | null; lang: Lang; status: PaymentStatus; review: Review | null; token: string }) {
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  const exponent = link?.exponent ?? guessExponent(status.currency);
  const fmt = (minor: number) => money(minor, status.currency, exponent, lang);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent?: boolean; fieldError?: string; error?: unknown } | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setResult(null);
    try {
      const r = await sendReceipt(token, email.trim(), lang);
      setResult({ sent: r.status === 'sent' });
    } catch (err) {
      setResult(err instanceof PayError && err.field === 'email' ? { fieldError: err.message } : { error: err });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="pay-form pay-receipt">
      <h2>{say('receipt.title')}</h2>
      <dl className="pay-summary">
        {link && <><dt>{say('receipt.paid_to')}</dt><dd>{link.project_name}</dd></>}
        {link && <><dt>{say('receipt.for')}</dt><dd>{link.title}</dd></>}
        <dt>{say('receipt.amount')}</dt><dd>{fmt(status.amount)}</dd>
        <dt>{say('receipt.fees')}</dt><dd>{fmt(status.charged_amount - status.amount)}</dd>
        <dt className="pay-total">{say('receipt.total')}</dt><dd className="pay-total">{fmt(status.charged_amount)}</dd>
        <dt>{say('receipt.method')}</dt><dd>{status.method.name}{review ? ` · ${review.msisdn_formatted}` : ''}</dd>
        <dt>{say('receipt.reference')}</dt><dd className="pay-mono">{status.reference}</dd>
      </dl>
      <form className="pay-field pay-email" onSubmit={send} noValidate>
        <label htmlFor="pay-email">{say('receipt.email')} <span className="pay-muted">{say('receipt.optional')}</span></label>
        <div className="pay-inline">
          <input
            id="pay-email" type="email" autoComplete="email" placeholder={say('receipt.placeholder')} value={email}
            aria-invalid={result?.fieldError ? true : undefined} aria-describedby="pay-email-error"
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" className="pay-button" disabled={sending || email.trim() === ''}>{sending ? say('receipt.sending') : say('receipt.send')}</button>
        </div>
        <FieldError id="pay-email-error" message={result?.fieldError} />
        {result?.sent === true && <p className="pay-ok" role="status">{say('receipt.sent')}</p>}
        {result?.sent === false && <p className="pay-error" role="alert">{say('receipt.failed')}</p>}
        {result?.error !== undefined && <p className="pay-error" role="alert">{describe(result.error, lang)}</p>}
      </form>
      <button type="button" className="pay-button pay-secondary pay-push" onClick={() => window.print()}>{say('receipt.print')}</button>
    </div>
  );
}
