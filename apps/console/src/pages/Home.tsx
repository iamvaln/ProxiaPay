import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { get, post, readableError } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, Empty, ErrorLine, ScopeNote, useEvery, useLoad } from '../components/common';
import { Headline } from '../components/Headline';
import { RouteChart } from '../components/RouteChart';
import { Verdict } from '../components/Verdict';
import { age, money, pct } from '../lib/format';
import type { CollectedToday, HomeCards, RateVsBaseline } from '../lib/home';

interface Home { cards: HomeCards }

/** Home (console spec 4.2): every block appears only when the API sent its data; an absent verdict is never replaced by a reassurance. */
export function HomeView({ cards, loadedAt }: { cards: HomeCards; loadedAt: Date }) {
  const t = useT();
  const discrepancies = cards.assigned_discrepancies ?? [];
  return (
    <>
      <h1>{t('nav.home')}</h1>
      {cards.verdict && <Verdict problems={cards.verdict.problems} loadedAt={loadedAt} />}
      {(cards.success_rate || cards.collected_today || cards.undetermined != null || cards.lowest_float) && <Headline cards={cards} />}
      <div className={cards.routes ? 'home-main' : undefined}>
        {cards.routes && <div className="card home-chart"><RouteChart series={cards.routes.series} /><ScopeNote scoped={cards.routes.scoped} /></div>}
        <section className="card waiting">
          <h2>{t('home.waiting')}</h2>
          {cards.awaiting_your_approval.length || discrepancies.length ? (
            <table><tbody>
              {cards.awaiting_your_approval.map((a) => (
                <tr key={a.id}><td><Link to="/approvals">{a.summary}</Link></td><td className="small muted">{a.initiator}</td><td className="num small">{age(a.created_at)}</td></tr>
              ))}
              {discrepancies.map((d) => (
                <tr key={d.id}>
                  <td><Link to={`/reconciliation/discrepancies/${d.id}`}>{d.type.replace(/_/g, ' ')} · {d.subject_reference}</Link></td>
                  <td />
                  <td className="num small">{d.difference != null && d.currency_code && <Amount minor={d.difference} currency={d.currency_code} />}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <Empty />}
        </section>
      </div>
      {cards.earnings && (
        <section className="business-line small muted">
          <span>{t('home.month_to_date')}</span>
          <ScopeNote scoped={cards.earnings.scoped} />
          {cards.earnings.rows.map((r) => (
            <span className="business-row" key={r.currency}>
              {r.currency}: {t('home.platform_revenue')} <Amount minor={r.platform_revenue} currency={r.currency} />
              {' · '}{t('home.margin')} <span className={r.margin < 0 ? 'business-margin negative' : 'business-margin'}><Amount minor={r.margin} currency={r.currency} /></span>
            </span>
          ))}
        </section>
      )}
    </>
  );
}

function AcceptButton({ membershipId }: { membershipId: string }) {
  const { refresh } = useSession();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true); setError(null);
    try { await post(`/auth/memberships/${membershipId}/accept`); await refresh(); } catch (e) { setError(readableError(e, t)); setBusy(false); }
  };
  return <><button type="button" className="primary" disabled={busy} onClick={() => void accept()}>{busy ? t('common.working') : t('pending.accept')}</button><ErrorLine error={error} /></>;
}

/** Memberships offered to this account and not yet accepted; accepting one makes the client available to switch to. */
export function PendingInvitations() {
  const { me } = useSession();
  const t = useT();
  if (!me?.pending_clients.length) return null;
  return (
    <section className="card">
      <h2>{t('pending.title')}</h2>
      {me.pending_clients.map((p) => (
        <div key={p.membership_id}>
          <p>{t('pending.invited', { client: p.client_name })}</p>
          <AcceptButton membershipId={p.membership_id} />
        </div>
      ))}
    </section>
  );
}

function LoadedHome() {
  const { data, error, reload } = useLoad(() => get<Home>('/home'));
  useEvery(reload, 60_000);
  // A new response object marks a successful load; "updated n s ago" counts from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadedAt = useMemo(() => new Date(), [data]);
  if (error && !data) return <ErrorLine error={error} />;
  if (!data) return <p className="muted">…</p>;
  return <HomeView cards={data.cards} loadedAt={loadedAt} />;
}

interface ClientHomeData { collected_today: CollectedToday[]; success_rate: RateVsBaseline; undetermined: number }

/** A client's home: the figures of its own projects, with nothing of the platform's (no verdict, chart, float or earnings) and no link to a platform page. */
export function ClientHomeView({ data }: { data: ClientHomeData }) {
  const t = useT();
  const { lang } = useSession();
  return (
    <>
      <h1>{t('nav.home')}</h1>
      <div className="headline">
        <div className="headline-figure">
          <span className="headline-label">{t('home.headline.collected')}</span>
          {data.collected_today.length === 0 && <span className="headline-value">—</span>}
          {data.collected_today.map((c) => <span className="headline-row" key={c.currency}><span className="headline-value">{money(c.today, c.currency, lang)}</span></span>)}
        </div>
        <div className="headline-figure">
          <span className="headline-label">{t('home.headline.success_rate')}</span>
          <span className="headline-value">{pct(data.success_rate.current)}</span>
        </div>
        <Link className="headline-figure" to="/transactions?state=undetermined">
          <span className="headline-label">{t('home.headline.undetermined')}</span>
          <span className="headline-value">{data.undetermined}</span>
          <span className="headline-detail small muted">{t('home.client.undetermined_detail')}</span>
        </Link>
      </div>
    </>
  );
}

function LoadedClientHome() {
  const { me } = useSession();
  // Keyed by the active client: a switch asks again, so one client's figures never stand for another's.
  const { data, error } = useLoad(() => get<ClientHomeData>('/client/home'), [me?.active_client?.id]);
  if (error && !data) return <ErrorLine error={error} />;
  if (!data) return <p className="muted">…</p>;
  return <ClientHomeView data={data} />;
}

export function HomePage() {
  const { me } = useSession();
  const t = useT();
  // A client account with no active client has no home yet: the invitation waiting for it is the page.
  if (me?.kind === 'client' && !me.active_client) {
    return <><h1>{t('nav.home')}</h1><PendingInvitations />{!me.pending_clients.length && <Empty text={t('pending.none')} />}</>;
  }
  return <><PendingInvitations />{me?.kind === 'client' ? <LoadedClientHome /> : <LoadedHome />}</>;
}
