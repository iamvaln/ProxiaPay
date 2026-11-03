import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { useT } from '../lib/session';
import { Amount, Empty, ErrorLine, useEvery, useLoad } from '../components/common';
import { Headline } from '../components/Headline';
import { RouteChart } from '../components/RouteChart';
import { Verdict } from '../components/Verdict';
import { age } from '../lib/format';
import type { HomeCards } from '../lib/home';

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
        {cards.routes && <div className="card home-chart"><RouteChart series={cards.routes.series} /></div>}
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

export function HomePage() {
  const { data, error, reload } = useLoad(() => get<Home>('/home'));
  useEvery(reload, 60_000);
  // A new response object marks a successful load; "updated n s ago" counts from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadedAt = useMemo(() => new Date(), [data]);
  if (error && !data) return <ErrorLine error={error} />;
  if (!data) return <p className="muted">…</p>;
  return <HomeView cards={data.cards} loadedAt={loadedAt} />;
}
