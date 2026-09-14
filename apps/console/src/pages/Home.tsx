import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, Empty, ErrorLine, Pill, ScopeNote, When, useLoad } from '../components/common';
import { age, pct } from '../lib/format';

interface Home { cards: Record<string, any> }

/** Home (console spec 4.2): cards drawn from the areas the administrator may see; the approval card comes first. */
export function HomePage() {
  const t = useT();
  const { me } = useSession();
  const { data, error } = useLoad(() => get<Home>('/home'));
  if (error) return <ErrorLine error={error} />;
  if (!data) return <p className="muted">…</p>;
  const c = data.cards;
  return (
    <>
      <h1>{t('nav.home')}</h1>
      <div className="cards">
        <div className="card">
          <h2>{t('home.approvals')}</h2>
          {c.awaiting_your_approval?.length ? (
            <table><tbody>{c.awaiting_your_approval.map((a: any) => (
              <tr key={a.id}><td><Link to="/approvals">{a.summary}</Link></td><td className="small muted">{a.initiator}</td><td className="num small">{age(a.created_at)}</td></tr>
            ))}</tbody></table>
          ) : <Empty />}
        </div>
        {c.open_alerts && (
          <div className="card">
            <h2>{t('home.alerts')}</h2>
            <div className="row">{Object.entries(c.open_alerts.by_severity).map(([s, n]) => <span key={s}><Pill value={s} /> {n as number}</span>)}</div>
            <ul>{c.open_alerts.recent_critical.map((a: any) => <li key={a.id}><Link to={`/oversight/alerts/${a.id}`}>{a.title}</Link> <span className="small muted"><When value={a.raised_at} /></span></li>)}</ul>
          </div>
        )}
        {c.float_cover && (
          <div className="card">
            <h2>{t('home.float')}</h2>
            <ScopeNote scoped={c.float_cover.scoped} />
            {c.float_cover.accounts.length ? (
              <table><tbody>{c.float_cover.accounts.map((f: any) => (
                <tr key={f.id}><td><Link to={`/treasury/float/${f.id}`}>{f.provider} {f.country} {f.currency} {f.direction}</Link></td><td><Pill value={f.band} /></td><td className="num">{f.cover_hours == null ? '—' : `${f.cover_hours} h`}</td></tr>
              ))}</tbody></table>
            ) : <Empty text="Every float account is in the healthy band." />}
          </div>
        )}
        {c.coverage_ratio && (
          <div className="card">
            <h2>{t('home.coverage')}</h2>
            {c.coverage_ratio.length ? (
              <table><thead><tr><th>Currency</th><th className="num">Float</th><th className="num">Encumbered</th><th className="num">Ratio</th></tr></thead>
                <tbody>{c.coverage_ratio.map((r: any) => <tr key={r.currency}><td>{r.currency}</td><td className="num"><Amount minor={r.float} currency={r.currency} /></td><td className="num"><Amount minor={r.encumbered} currency={r.currency} /></td><td className={`num ${r.ratio != null && r.ratio < 1 ? 'negative' : ''}`}>{r.ratio ?? '—'}</td></tr>)}</tbody></table>
            ) : <Empty />}
          </div>
        )}
        {c.open_discrepancies && (
          <div className="card">
            <h2>{t('home.discrepancies')}</h2>
            <div className="row">{Object.entries(c.open_discrepancies.by_type).map(([k, n]) => <span key={k}><Pill value={k} /> {n as number}</span>)}</div>
            {c.open_discrepancies.assigned_to_me.length > 0 && <ul>{c.open_discrepancies.assigned_to_me.map((d: any) => <li key={d.id}><Link to={`/reconciliation/discrepancies/${d.id}`}>{d.type.replace(/_/g, ' ')} · {d.subject_reference}</Link></li>)}</ul>}
          </div>
        )}
        {c.todays_activity && (
          <div className="card">
            <h2>{t('home.activity')}</h2>
            <ScopeNote scoped={c.todays_activity.scoped} />
            {c.todays_activity.rows.length ? (
              <table><thead><tr><th>Direction</th><th className="num">Count</th><th className="num">Value</th><th className="num">Success</th><th className="num">Baseline</th></tr></thead>
                <tbody>{c.todays_activity.rows.map((r: any) => <tr key={r.direction + r.currency_code}><td>{r.direction}</td><td className="num">{r.n}</td><td className="num"><Amount minor={r.value} currency={r.currency_code} /></td><td className="num">{pct(r.success_rate)}</td><td className="num muted">{pct(r.baseline_success_rate)}</td></tr>)}</tbody></table>
            ) : <Empty />}
          </div>
        )}
        {c.earnings && (
          <div className="card">
            <h2>{t('home.earnings')}</h2>
            <p className="small muted">Month to date. Margin is processing fees less what providers actually charged, and sits apart from earnings.</p>
            <ScopeNote scoped={c.earnings.scoped} />
            {c.earnings.rows.length ? (
              <table><thead><tr><th>Currency</th><th className="num">{t('home.platform_revenue')}</th><th className="num">{t('home.margin')}</th></tr></thead>
                <tbody>{c.earnings.rows.map((r: any) => <tr key={r.currency}><td>{r.currency}</td><td className="num"><Amount minor={r.platform_revenue} currency={r.currency} /></td><td className="num"><Amount minor={r.margin} currency={r.currency} /></td></tr>)}</tbody></table>
            ) : <Empty />}
          </div>
        )}
        {c.provider_status && (
          <div className="card">
            <h2>{t('home.providers')}</h2>
            <table><tbody>{c.provider_status.map((p: any) => <tr key={p.id}><td><Link to={`/configuration/providers/${p.id}`}>{p.name}</Link></td><td><Pill value={p.status} /></td></tr>)}</tbody></table>
          </div>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 16 }}>{me?.administrator.email} · {me?.environment}</p>
    </>
  );
}
