import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Mark } from '../components/Logo';
import { confirmPayment, createPreview, getLink, getPayment, PayError, quote as fetchQuote, sendReceipt, type LinkMethod, type LinkView, type PaymentStatus, type Quote, type Review } from './api';
import { detectCountry, zoneOf } from './country';
import { countryName, detectLanguage, money, parseAmount, t, type Key, type Lang } from './i18n';

/**
 * The page a payer opens from a payment link (spec: payment links, the page): the link's form, the review of the total,
 * the request sent to the payer's phone, and the outcome. It types nothing after confirming: the operator asks the payer,
 * and the page follows the payment until the outcome is in.
 */

export interface PayTimings {
  /** How often the page asks for the payment's state in the first minute, then after it. */
  pollFast: number; pollSlow: number; slowAfter: number;
  /** How long the page keeps asking about a payment the operator has not settled (undetermined). */
  checkingFor: number;
  /** How long the payer pauses typing an amount before the page prices it. */
  quoteDelay: number;
}
const TIMINGS: PayTimings = { pollFast: 3000, pollSlow: 10_000, slowAfter: 60_000, checkingFor: 30 * 60_000, quoteDelay: 400 };

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

/** A logo is shown only from the pay API's own asset path: anything else in the field is ignored, never fetched. */
const LOGO_PATH = '/pay-api/v1/assets/';

type Stage =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'load-failed'; error: unknown }
  | { kind: 'form' }
  | { kind: 'review'; token: string; review: Review }
  | { kind: 'following'; token: string; review: Review | null; status: PaymentStatus | null };

/**
 * What the payer reads when a call fails, always in the page's language: the page words every code the pay API gives it,
 * and anything it does not know is the generic sentence. The API's own message is never shown.
 */
export function describe(e: unknown, lang: Lang): string {
  const say = (key: Key) => t(lang, key);
  if (!(e instanceof PayError)) return say('error.network');
  if (e.status === 429 || e.code === 'RATE_LIMITED') return say('error.rate_limited');
  const words: Record<string, Key> = {
    LINK_UNAVAILABLE: 'page.unavailable',
    LINK_PAYMENT_IN_PROGRESS: 'error.in_progress',
    LINK_PAYMENT_BEING_CHECKED: 'error.being_checked',
    RECEIPT_LIMIT_REACHED: 'error.receipt_limit',
    RECEIPT_NOT_READY: 'error.receipt_not_ready',
    PREVIEW_EXPIRED: 'error.total_expired',
    SIMILAR_PAYMENT_PENDING: 'error.number_pending',
    NO_PROVIDER_AVAILABLE: 'error.method_down',
    FLOAT_INSUFFICIENT: 'error.method_down',
    VELOCITY_COUNT_EXCEEDED: 'error.link_busy',
    VELOCITY_VALUE_EXCEEDED: 'error.link_busy',
    NOT_FOUND: 'error.payment_gone',
  };
  return say(words[e.code] ?? 'error.generic');
}

/** The field a refusal is about, when it is one the page shows beside a field; anything else is shown above the button. */
const fieldOf = (e: unknown): 'amount' | 'msisdn' | 'method' | 'email' | null =>
  e instanceof PayError && e.status !== 429 && (e.field === 'amount' || e.field === 'msisdn' || e.field === 'method' || e.field === 'email') ? e.field : null;

/** Why a typed amount cannot be paid with a method, worked out on the page so the payer reads it in their language. */
function amountProblem(lang: Lang, link: LinkView, method: LinkMethod | null, text: string): string | undefined {
  const fmt = (minor: number) => money(minor, link.currency, link.exponent, lang);
  const amount = parseAmount(text, link.exponent);
  const floor = method?.minimum_amount ?? link.minimum_amount;
  if (amount === null) return t(lang, 'form.amount_invalid');
  if (amount < floor) return t(lang, 'form.amount_min', { amount: fmt(floor) });
  if (method && amount > method.maximum_amount) return t(lang, 'form.amount_max', { amount: fmt(method.maximum_amount) });
  return undefined;
}

const FINAL_FAILURES = new Set(['failed', 'expired']);

/** The client's face as the panel shows it: from the link, or from the payment once the link is gone. */
interface Face { project_name: string; title: string; description: string | null; amount: string | null; logo_url: string | null; primary_color: string; sandbox: boolean }

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

  // Follows the payment: every few seconds, then less often, until its outcome is in; a payment the operator has not
  // settled is followed for half an hour, then left to the pending message. A change of language reads it again at once,
  // but keeps the pace: the clock runs from when this payment was first followed.
  const followToken = stage.kind === 'following' ? stage.token : null;
  const followedSince = useRef<{ token: string; at: number } | null>(null);
  useEffect(() => {
    if (!followToken) return;
    if (followedSince.current?.token !== followToken) followedSince.current = { token: followToken, at: Date.now() };
    const started = followedSince.current.at;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const status = await getPayment(followToken, lang);
        if (!live) return;
        setStage((s) => (s.kind === 'following' && s.token === followToken ? { ...s, status } : s));
        if (status.outcome) return;
        if (status.state === 'undetermined' && Date.now() - started >= tm.checkingFor) return;
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

  const status = stage.kind === 'following' ? stage.status : null;
  const face: Face | null = link
    ? {
      project_name: link.project_name, title: link.title, description: link.description, logo_url: link.brand.logo_url, primary_color: link.brand.primary_color, sandbox: link.sandbox,
      amount: link.amount_type === 'fixed' && link.amount !== null ? money(link.amount, link.currency, link.exponent, lang) : say('page.amount_free'),
    }
    : status
      ? { project_name: status.project_name, title: status.title, description: null, amount: null, logo_url: status.brand.logo_url, primary_color: status.brand.primary_color, sandbox: status.sandbox }
      : null;
  const brandStyle = face ? ({ '--pay-primary': face.primary_color } as CSSProperties) : undefined;
  const succeeded = status?.state === 'succeeded';

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
          onFollow={() => setStage({ kind: 'following', token: stage.token, review: stage.review, status: null })}
          onMethodGone={async () => {
            const view = await refreshLink();
            if (view) keepOffered(view);
          }}
        />
      );
      break;
    case 'following': {
      const { review, token } = stage;
      if (!status) body = <p className="pay-muted" role="status">{say('page.loading')}</p>;
      else if (status.state === 'succeeded') body = <Receipt lang={lang} status={status} token={token} />;
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
      else body = <Waiting lang={lang} status={status} review={review} />;
      break;
    }
  }

  return (
    <div className="pay-page" style={brandStyle}>
      {face?.sandbox && <div className="pay-band">{say('page.sandbox')}</div>}
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
          <Panel face={face} lang={lang} succeeded={succeeded} />
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
function Panel({ face, lang, succeeded }: { face: Face | null; lang: Lang; succeeded: boolean }) {
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  return (
    <aside className="pay-panel">
      {face && (
        <div className="pay-brand">
          {face.logo_url?.startsWith(LOGO_PATH)
            ? <img className="pay-logo" src={face.logo_url} alt="" />
            : <span className="pay-logo pay-initial" aria-hidden="true">{face.project_name.trim().charAt(0).toUpperCase()}</span>}
          <span className="pay-project">{face.project_name}</span>
        </div>
      )}
      {succeeded ? (
        <div className="pay-intro">
          <span className="pay-check" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg></span>
          <h1>{say('success.title')}</h1>
          {face && <p>{say('success.thanks', { project: face.project_name })}</p>}
        </div>
      ) : face && (
        <div className="pay-intro">
          <h1>{face.title}</h1>
          {face.description && <p>{face.description}</p>}
          {face.amount && <p className="pay-panel-amount">{face.amount}</p>}
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

type FormErrors = { amount?: unknown; method?: unknown; msisdn?: unknown; form?: unknown };

function PayForm(props: {
  link: LinkView; lang: Lang; timings: PayTimings; country: string; methodKey: string; msisdn: string; amountText: string;
  onCountry: (c: string) => void; onMethod: (k: string) => void; onMsisdn: (v: string) => void; onAmount: (v: string) => void;
  onUnavailable: () => void; onMethodGone: () => Promise<void>; onReview: (token: string, review: Review) => void;
}) {
  const { link, lang, country, methodKey, msisdn, amountText } = props;
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  const fmt = (minor: number) => money(minor, link.currency, link.exponent, lang);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [amountTouched, setAmountTouched] = useState(false);
  const [quoted, setQuoted] = useState<{ quote?: Quote; error?: unknown } | null>(null);

  const free = link.amount_type === 'free';
  const methods = link.methods.filter((m) => m.country === country);
  const method = link.methods.find((m) => m.key === methodKey) ?? null;
  const place = link.countries.find((c) => c.code === country);
  const amount = free ? parseAmount(amountText, link.exponent) : link.amount;
  const floor = method?.minimum_amount ?? link.minimum_amount;
  const localAmountError = free ? amountProblem(lang, link, method, amountText) : undefined;

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

  /** A refusal of one of the form's fields, in the payer's words: the amount is judged again here, against the figures the page has. */
  const fieldText = (field: 'amount' | 'msisdn' | 'method'): string => {
    if (field === 'amount') return localAmountError ?? say('error.amount_not_payable');
    if (field === 'msisdn') return say('error.msisdn', { country: place ? countryName(place.code, place.name, lang) : '' });
    return say('error.method_unavailable');
  };
  const quoteFailure = quoted?.error;
  const quoteField = fieldOf(quoteFailure);
  const quoteError = quoteFailure === undefined ? undefined : quoteField === 'amount' || quoteField === 'method' ? fieldText(quoteField) : describe(quoteFailure, lang);
  // A figure being typed is not judged until the payer leaves the field or continues; the minimum stays in view meanwhile.
  const amountError = errors.amount !== undefined ? fieldText('amount') : (amountTouched ? localAmountError : undefined) ?? quoteError;

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
      const field = fieldOf(err);
      if (field && field !== 'email') {
        setErrors({ [field]: err });
        if (field === 'method') void props.onMethodGone();
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
            <select id="pay-country" value={country} onChange={(e) => { props.onCountry(e.target.value); setErrors((x) => ({ ...x, msisdn: undefined, method: undefined })); }}>
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
          <FieldError id="pay-method-error" message={errors.method !== undefined ? fieldText('method') : undefined} />
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
            aria-invalid={errors.msisdn !== undefined ? true : undefined} aria-describedby="pay-msisdn-error"
            onChange={(e) => { props.onMsisdn(e.target.value); setErrors((x) => ({ ...x, msisdn: undefined })); }}
          />
        </div>
        <FieldError id="pay-msisdn-error" message={errors.msisdn !== undefined ? fieldText('msisdn') : undefined} />
      </div>
      {errors.form !== undefined && <p className="pay-error pay-form-error" role="alert">{describe(errors.form, lang)}</p>}
      <button type="submit" className="pay-button pay-push" disabled={busy || !method}>{busy ? say('form.wait') : say('form.continue')}</button>
    </form>
  );
}

/**
 * A refusal the platform made before anything started: its own error body, 4xx, and not a rate limit. The transaction is
 * committed before the operator is asked, so a server fault, a gateway's page or a limit hit on a retry may come after it.
 */
const isRefusal = (e: unknown): e is PayError => e instanceof PayError && e.answered && e.status >= 400 && e.status < 500 && e.status !== 429;

/** What the payer reads when the confirmation is refused: a field's refusal in the form's words, anything else as described. */
function confirmText(e: unknown, lang: Lang): string {
  const field = fieldOf(e);
  if (field === 'method') return t(lang, 'error.method_unavailable');
  if (field === 'amount') return t(lang, 'error.amount_not_payable');
  return describe(e, lang);
}

function ReviewStep({ link, lang, review, token, onEdit, onUnavailable, onFollow, onMethodGone }: {
  link: LinkView; lang: Lang; review: Review; token: string; onEdit: () => void; onUnavailable: () => void; onFollow: () => void; onMethodGone: () => Promise<void>;
}) {
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  const fmt = (minor: number) => money(minor, review.currency, link.exponent, lang);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  // The confirmation went out and no answer came back: the payment may have started, so the payer checks it rather than edits.
  const [uncertain, setUncertain] = useState(false);
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
      onFollow();
    } catch (e) {
      if (isRefusal(e)) {
        keepToken(null);
        if (e.code === 'LINK_UNAVAILABLE') { onUnavailable(); return; }
        if (fieldOf(e) === 'method') void onMethodGone();
      } else {
        // The token stays: confirming again returns the same payment, and following it shows whether it started.
        setUncertain(true);
      }
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
        <dt>{say('review.fees')}</dt><dd>{fmt(review.fees_borne_by_payer)}</dd>
        <dt>{say('review.method')}</dt><dd>{review.method.name} · {countryName(review.method.country, place?.name ?? review.method.country, lang)}</dd>
        <dt>{say('review.number')}</dt><dd>{review.msisdn_formatted}</dd>
        <dt className="pay-total">{say('review.total')}</dt><dd className="pay-total">{fmt(review.total)}</dd>
      </dl>
      <p className="pay-hint">
        {say('review.holds', { duration: minutes === 1 ? say('review.minute') : say('review.minutes', { n: minutes }), operator: review.method.name })}
      </p>
      {error !== undefined && <p className="pay-error pay-form-error" role="alert">{confirmText(error, lang)}</p>}
      <div className="pay-actions pay-push">
        {uncertain
          ? <button type="button" className="pay-button pay-secondary" onClick={onFollow} disabled={busy}>{say('review.check')}</button>
          : <button type="button" className="pay-button pay-secondary" onClick={onEdit} disabled={busy}>{say('review.edit')}</button>}
        <button type="button" className="pay-button pay-grow" onClick={() => { void confirm(); }} disabled={busy}>
          {busy ? say('form.wait') : say('review.confirm', { total: fmt(review.total) })}
        </button>
      </div>
    </div>
  );
}

function Waiting({ lang, status, review }: { lang: Lang; status: PaymentStatus; review: Review | null }) {
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  const operator = status.method.name;
  return (
    <div className="pay-form" aria-live="polite">
      <div className="pay-heading">
        <svg className="pay-accent" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></svg>
        <h2>{say('sent.title')}</h2>
      </div>
      <p>{review ? say('sent.body', { number: review.msisdn_formatted, operator }) : say('sent.body_phone', { operator })}</p>
      <p className="pay-hint">{say('sent.total', { total: money(status.charged_amount, status.currency, status.exponent, lang) })}</p>
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

/** When the payment became final, in the payer's language and the method country's time (else the browser's). */
export function paidAt(iso: string, country: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: zoneOf(country) }).format(new Date(iso));
}

function Receipt({ lang, status, token }: { lang: Lang; status: PaymentStatus; token: string }) {
  const say = (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
  const fmt = (minor: number) => money(minor, status.currency, status.exponent, lang);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent?: boolean; badAddress?: boolean; error?: unknown } | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setResult(null);
    try {
      const r = await sendReceipt(token, email.trim(), lang);
      setResult({ sent: r.status === 'sent' });
    } catch (err) {
      setResult(fieldOf(err) === 'email' ? { badAddress: true } : { error: err });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="pay-form pay-receipt">
      <h2>{say('receipt.title')}</h2>
      <dl className="pay-summary">
        <dt>{say('receipt.paid_to')}</dt><dd>{status.project_name}</dd>
        <dt>{say('receipt.for')}</dt><dd>{status.title}</dd>
        <dt>{say('receipt.amount')}</dt><dd>{fmt(status.amount)}</dd>
        <dt>{say('receipt.fees')}</dt><dd>{fmt(status.charged_amount - status.amount)}</dd>
        <dt className="pay-total">{say('receipt.total')}</dt><dd className="pay-total">{fmt(status.charged_amount)}</dd>
        <dt>{say('receipt.method')}</dt><dd>{status.method.name} · {status.msisdn_masked}</dd>
        {status.completed_at && <><dt>{say('receipt.date')}</dt><dd>{paidAt(status.completed_at, status.method.country, lang)}</dd></>}
        <dt>{say('receipt.reference')}</dt><dd className="pay-mono">{status.reference}</dd>
      </dl>
      <form className="pay-field pay-email" onSubmit={send} noValidate>
        <label htmlFor="pay-email">{say('receipt.email')} <span className="pay-muted">{say('receipt.optional')}</span></label>
        <div className="pay-inline">
          <input
            id="pay-email" type="email" autoComplete="email" placeholder={say('receipt.placeholder')} value={email}
            aria-invalid={result?.badAddress ? true : undefined} aria-describedby="pay-email-error"
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" className="pay-button" disabled={sending || email.trim() === ''}>{sending ? say('receipt.sending') : say('receipt.send')}</button>
        </div>
        <FieldError id="pay-email-error" message={result?.badAddress ? say('error.email') : undefined} />
        {result?.sent === true && <p className="pay-ok" role="status">{say('receipt.sent')}</p>}
        {result?.sent === false && <p className="pay-error" role="alert">{say('receipt.failed')}</p>}
        {result?.error !== undefined && <p className="pay-error" role="alert">{describe(result.error, lang)}</p>}
      </form>
      <button type="button" className="pay-button pay-secondary pay-push" onClick={() => window.print()}>{say('receipt.print')}</button>
    </div>
  );
}
