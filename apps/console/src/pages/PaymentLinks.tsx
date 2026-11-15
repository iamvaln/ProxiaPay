import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { figureOf, toMinor } from '../lib/format';
import { ErrorLine, Pill, SubmitForm, When, useLoad } from '../components/common';
import { QrCode } from '../components/QrCode';
import { DataTable, type Column } from '../components/table/DataTable';
import { ColorFields, HeaderPreview, type BrandColors } from './Brand';

type LinkRow = {
  id: string; code: string; url: string; title: string; amount_type: 'fixed' | 'free'; amount: number | null; minimum_amount: number; currency: string;
  single_use: boolean; expires_at: string | null; status: string;
  methods: { country: string; payment_method: string; payment_method_name: string }[];
  payments: { count: number; succeeded: number; total_collected: number; last_at: string | null };
};
type UsableRoute = { id: string; country: string; payment_method: string; payment_method_name: string; currency: string; exponent: number; minimum_amount: number; maximum_amount: number };
/** Each currency's decimals, as the platform's currency table gives them with the routes. */
type Exponents = Record<string, number>;

/**
 * A link amount, written with its currency's decimals from the platform. A currency with no route loaded has no known
 * exponent: no figure is shown rather than one that could be a hundred times off.
 */
function LinkAmount({ minor, currency, exponents }: { minor: number | null; currency: string; exponents: Exponents }) {
  const { lang } = useSession();
  const exp = exponents[currency];
  if (minor == null || exp === undefined) return <span className="muted">—</span>;
  return <span className="amount"><span className="amount-figure">{figureOf(minor, exp, lang)}</span> <span className="amount-currency">{currency}</span></span>;
}

/** Copies the address; says so for two seconds, or asks for a manual copy when the browser refuses. */
function CopyUrl({ value }: { value: string }) {
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
      <button type="button" onClick={copy}>{state === 'copied' ? t('pl.copied') : t('pl.copy')}</button>
      {state === 'failed' && <span className="small negative">{t('pl.copy_failed')}</span>}
    </>
  );
}

/** The list, one row per link: what it asks, where it can be paid, what it collected, and what can be done with it. */
function LinkList({ id, links, exponents, manage, reload }: { id: string; links: LinkRow[]; exponents: Exponents; manage: boolean; reload: () => void }) {
  const t = useT();
  const { lang, has } = useSession();
  const [error, setError] = useState<string | null>(null);
  const disable = async (l: LinkRow) => {
    // A disabled link cannot be enabled again: the owner says so first.
    if (!window.confirm(t('pl.disable_confirm'))) return;
    setError(null);
    try { await post(`/projects/${id}/payment-links/${l.id}/disable`); reload(); } catch (e) { setError((e as Error).message); }
  };
  const amountOf = (l: LinkRow) => {
    if (l.amount_type === 'fixed') return <LinkAmount minor={l.amount} currency={l.currency} exponents={exponents} />;
    if (l.minimum_amount <= 0) return t('pl.amount_free_any');
    const exp = exponents[l.currency];
    return exp === undefined ? <span className="muted">—</span> : t('pl.amount_free', { amount: `${figureOf(l.minimum_amount, exp, lang)} ${l.currency}` });
  };
  const columns: Column<LinkRow>[] = [
    { key: 'title', label: t('col.link'), render: (l) => <><b>{l.title}</b>{l.single_use && <span className="small muted"> · {t('pl.single_use')}</span>}</> },
    { key: 'amount', label: t('col.amount'), render: amountOf },
    { key: 'methods', label: t('col.methods'), render: (l) => <span className="small">{l.methods.map((m) => `${m.country} ${m.payment_method_name}`).join(', ')}</span> },
    { key: 'status', label: t('col.status'), render: (l) => <Pill value={l.status} /> },
    { key: 'payments', label: t('col.payments'), align: 'end', render: (l) => t('pl.payments_cell', { succeeded: l.payments.succeeded, count: l.payments.count }) },
    { key: 'collected', label: t('col.collected'), align: 'end', render: (l) => <LinkAmount minor={l.payments.total_collected} currency={l.currency} exponents={exponents} /> },
    { key: 'last_payment', label: t('col.last_payment'), render: (l) => <When value={l.payments.last_at} /> },
    { key: 'actions', label: t('table.actions'), render: (l) => (
      <div className="row">
        {l.url && <CopyUrl value={l.url} />}
        {l.url && <details><summary>{t('pl.qr')}</summary><QrCode value={l.url} alt={t('pl.qr_alt', { title: l.title })} size={160} /></details>}
        {has('transactions.read') && <Link to={`/transactions?payment_link=${l.id}`}>{t('pl.view_payments')}</Link>}
        {manage && l.status === 'active' && <button type="button" onClick={() => disable(l)}>{t('pl.disable')}</button>}
      </div>
    ) },
  ];
  return (
    <>
      {links.some((l) => !l.url) && <p className="warnbox">{t('pl.not_configured')}</p>}
      <ErrorLine error={error} />
      <DataTable<LinkRow> bare rows={links} rowKey={(l) => l.id} columns={columns} defaultSort="title" empty={{ none: t('pl.none'), why: t('pl.none_why') }} />
      {links.some((l) => l.expires_at) && <p className="small muted">{links.filter((l) => l.expires_at).map((l) => <span key={l.id}>{l.title}: <When value={l.expires_at} /> </span>)}</p>}
    </>
  );
}

/** Owner only. The methods are the project's own routes a payer can use from a phone alone, grouped by country. */
function CreateForm({ id, name, routes, exponents, brand, reload }: { id: string; name: string; routes: UsableRoute[]; exponents: Exponents; brand: BrandColors; reload: () => void }) {
  const t = useT();
  const currencies = [...new Set(routes.map((r) => r.currency))].sort();
  const [form, setForm] = useState({ title: '', description: '', currency: currencies[0] ?? '', amount_type: 'fixed' as 'fixed' | 'free', amount: '', minimum: '', single_use: false, expires: '' });
  const [picked, setPicked] = useState<string[]>([]);
  const [colors, setColors] = useState<BrandColors>(brand);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const here = routes.filter((r) => r.currency === form.currency);
  const countries = [...new Set(here.map((r) => r.country))];
  const chosen = picked.filter((rid) => here.some((r) => r.id === rid));
  // The currency's decimals from the platform; none known (no route loaded for it) means no amount can be typed.
  const exp: number | undefined = exponents[form.currency];
  const step = exp === undefined ? 1 : 1 / 10 ** exp;
  // Typed in the currency as people write it; the API takes minor units.
  const minor = (text: string): number => {
    if (exp === undefined) throw new Error(t('pl.f_methods_none'));
    const v = toMinor(text, exp);
    if (v === null) throw new Error(exp === 0 ? t('pl.f_amount_whole', { currency: form.currency }) : t('pl.f_amount_invalid', { currency: form.currency, n: exp }));
    return v;
  };
  const submit = async () => {
    if (!chosen.length) throw new Error(t('pl.f_pick_method'));
    const body = {
      title: form.title, ...(form.description ? { description: form.description } : {}), currency: form.currency, amount_type: form.amount_type,
      ...(form.amount_type === 'fixed' ? { amount: minor(form.amount) } : { minimum_amount: minor(form.minimum || '0') }),
      route_ids: chosen, single_use: form.single_use, ...(form.expires ? { expires_at: new Date(form.expires).toISOString() } : {}),
      brand: { primary_color: colors.primary_color, secondary_color: colors.secondary_color },
    };
    const made = await post<{ id: string; url: string }>(`/projects/${id}/payment-links`, body);
    setForm({ ...form, title: '', description: '', amount: '', minimum: '', expires: '' }); setPicked([]); reload();
    return made.url ? t('pl.created', { url: made.url }) : t('pl.created_no_url');
  };
  return (
    <div className="card" id="new-link">
      <h2>{t('pl.new')}</h2>
      <SubmitForm submitLabel={t('pl.create')} onSubmit={submit}>
        <label>{t('pl.f_title')}<input value={form.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} required /></label>
        <label>{t('pl.f_description')}<textarea value={form.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} /></label>
        <label>{t('pl.f_currency')}<select value={form.currency} onChange={(e) => set({ currency: e.target.value })}>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <fieldset>
          <legend>{t('pl.f_amount_type')}</legend>
          <label className="row"><input type="radio" name="amount_type" checked={form.amount_type === 'fixed'} onChange={() => set({ amount_type: 'fixed' })} /> {t('pl.f_fixed')}</label>
          <label className="row"><input type="radio" name="amount_type" checked={form.amount_type === 'free'} onChange={() => set({ amount_type: 'free' })} /> {t('pl.f_free')}</label>
        </fieldset>
        {form.amount_type === 'fixed'
          ? <label>{t('pl.f_amount', { currency: form.currency })}<input type="number" min={step} step={step} disabled={exp === undefined} value={form.amount} onChange={(e) => set({ amount: e.target.value })} required /></label>
          : <label>{t('pl.f_minimum', { currency: form.currency })}<input type="number" min={0} step={step} disabled={exp === undefined} value={form.minimum} onChange={(e) => set({ minimum: e.target.value })} /></label>}
        <fieldset>
          <legend>{t('pl.f_methods')}</legend>
          {here.length === 0 && <p className="small muted">{t('pl.f_methods_none')}</p>}
          {countries.map((c) => (
            <div key={c} className="row">
              <b>{c}</b>
              {here.filter((r) => r.country === c).map((r) => (
                <label key={r.id} className="row"><input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /> {r.payment_method_name}</label>
              ))}
            </div>
          ))}
        </fieldset>
        <label className="row"><input type="checkbox" checked={form.single_use} onChange={(e) => set({ single_use: e.target.checked })} /> {t('pl.f_single_use')}</label>
        <label>{t('pl.f_expires')}<input type="datetime-local" value={form.expires} onChange={(e) => set({ expires: e.target.value })} /></label>
        <fieldset>
          <legend>{t('pl.f_brand')}</legend>
          <ColorFields value={colors} onChange={setColors} />
          <HeaderPreview colors={colors} logo={null} name={name} />
        </fieldset>
      </SubmitForm>
    </div>
  );
}

/** The project's payment links. Anyone who reads the project sees the list; making and disabling is `links.manage`. */
export function PaymentLinksTab({ id, name }: { id: string; name: string }) {
  const t = useT();
  const { has } = useSession();
  const manage = has('links.manage');
  const links = useLoad(() => get<{ links: LinkRow[] }>(`/projects/${id}/payment-links`), [id]);
  // Read by everyone who sees the list: the routes carry each currency's decimals, which every link amount is written with.
  const routes = useLoad(() => get<{ routes: UsableRoute[] }>(`/projects/${id}/payment-links/routes`), [id]);
  const exponents: Exponents = Object.fromEntries((routes.data?.routes ?? []).map((r) => [r.currency, r.exponent]));
  const brand = useLoad(() => (manage ? get<BrandColors>(`/projects/${id}/brand`) : Promise.resolve(null)), [id, manage]);
  if (links.error) return <ErrorLine error={links.error} />;
  return (
    <>
      <div className="card" id="links">
        <h2>{t('pl.title')}</h2>
        {links.data && <LinkList id={id} links={links.data.links} exponents={exponents} manage={manage} reload={links.reload} />}
      </div>
      {manage && routes.data && brand.data && <CreateForm key={brand.data.primary_color + brand.data.secondary_color} id={id} name={name} routes={routes.data.routes} exponents={exponents} brand={{ primary_color: brand.data.primary_color, secondary_color: brand.data.secondary_color }} reload={links.reload} />}
      <ErrorLine error={routes.error ?? brand.error} />
    </>
  );
}
