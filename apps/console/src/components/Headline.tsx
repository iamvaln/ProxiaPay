import { Link } from 'react-router-dom';
import { ScopeNote } from './common';
import { money, pct } from '../lib/format';
import type { HomeCards } from '../lib/home';
import { useSession, useT } from '../lib/session';
import { changeVsLastWeek } from '../lib/verdict';

function signed(ratio: number, lang: string): string {
  const n = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(ratio * 100);
  return `${n} %`;
}

/** The four headline figures that the administrator's permissions let the API send; each links to where you act on it. */
export function Headline({ cards }: { cards: HomeCards }) {
  const t = useT();
  const { lang } = useSession();
  const { success_rate: rate, collected_today: collected, undetermined, lowest_float: float } = cards;
  // The rate, collections and undetermined count share the reports scope, which the API reports on the route series.
  const scoped = cards.routes?.scoped;
  return (
    <div className="headline">
      {rate && (
        <Link className="headline-figure" to="/oversight/health">
          <span className="headline-label">{t('home.headline.success_rate')}</span>
          <span className="headline-value">{pct(rate.current)}</span>
          {rate.baseline != null && <span className="headline-detail small muted">{t('home.headline.normal', { rate: pct(rate.baseline) })}</span>}
          <ScopeNote scoped={scoped} />
        </Link>
      )}
      {collected && (
        <Link className="headline-figure" to="/oversight/reports">
          <span className="headline-label">{t('home.headline.collected')}</span>
          {collected.length === 0 && <span className="headline-value">—</span>}
          {collected.map((c) => {
            const change = changeVsLastWeek(c.today, c.last_week);
            return (
              <span className="headline-row" key={c.currency}>
                <span className="headline-value">{money(c.today, c.currency, lang)}</span>
                {change != null && <span className={`headline-detail small ${change < 0 ? 'negative' : 'muted'}`}>{t('home.headline.vs_last_week', { change: signed(change, lang) })}</span>}
              </span>
            );
          })}
          <ScopeNote scoped={scoped} />
        </Link>
      )}
      {undetermined != null && (
        <Link className="headline-figure" to="/transactions?state=undetermined">
          <span className="headline-label">{t('home.headline.undetermined')}</span>
          <span className="headline-value">{undetermined}</span>
          <span className="headline-detail small muted">{t('home.headline.undetermined_detail')}</span>
          <ScopeNote scoped={scoped} />
        </Link>
      )}
      {float && (
        <Link className="headline-figure" to={`/treasury/float/${float.id}`}>
          <span className="headline-label">{t('home.headline.lowest_float')}</span>
          <span className="headline-value">{float.cover_hours == null ? '—' : t('home.headline.cover_hours', { hours: float.cover_hours })}</span>
          <span className="headline-detail small muted">
            {float.provider} {float.country} {t(`home.chart.${float.direction}`)}
            {float.proposed_transfer != null && ` · ${t('home.headline.transfer', { amount: money(float.proposed_transfer, float.currency, lang) })}`}
          </span>
          <ScopeNote scoped={float.scoped} />
        </Link>
      )}
    </div>
  );
}
