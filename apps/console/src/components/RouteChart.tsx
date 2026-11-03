import { useRef, useState } from 'react';
import { useT } from '../lib/session';
import type { RouteSeries } from '../lib/home';
import { countryChips, operatorColour, points, spreadLabels, view } from '../lib/routeChart';

const W = 760, H = 240, L = 40, R = 130, T = 8, B = 26;
const PW = W - L - R, PH = H - T - B, N = 24;
const GRID = [0.5, 0.6, 0.7, 0.8, 0.9, 1];

// Values below 50 % pin to the axis.
const x = (i: number) => L + i * (PW / (N - 1));
const y = (v: number) => T + (1 - (Math.max(0.5, v) - 0.5) / 0.5) * PH;
const whole = (v: number) => Math.round(v * 100);
const hourLabel = (iso: string) => `${String(new Date(iso).getHours()).padStart(2, '0')} h`;

/** A line over its drawable hours; a thin hour lifts the pen. */
function linePath(ps: (number | null)[]): string {
  let d = '', pen = false;
  ps.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** The band is one filled path per run of hours where at least one calm route has a point. */
function bandPath(lo: (number | null)[], hi: (number | null)[]): string {
  const runs: number[][] = [];
  let run: number[] = [];
  lo.forEach((v, i) => { if (v != null && hi[i] != null) run.push(i); else if (run.length) { runs.push(run); run = []; } });
  if (run.length) runs.push(run);
  return runs.map((r) => {
    const top = r.map((i) => `${x(i).toFixed(1)},${y(hi[i]!).toFixed(1)}`).join(' L');
    const bot = [...r].reverse().map((i) => `${x(i).toFixed(1)},${y(lo[i]!).toFixed(1)}`).join(' L');
    return `M${top} L${bot} Z`;
  }).join(' ');
}

function lastIndex(ps: (number | null)[]): number {
  for (let i = ps.length - 1; i >= 0; i--) if (ps[i] != null) return i;
  return -1;
}

export function RouteChart({ series }: { series: RouteSeries[] }) {
  const t = useT();
  const [direction, setDirection] = useState<'collection' | 'disbursement'>('collection');
  const [country, setCountry] = useState<string>('all');
  const [hover, setHover] = useState<{ i: number; left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const chips = countryChips(series, direction);
  const active = country === 'all' || chips.some((c) => c.country === country) ? country : 'all';
  const { lines, band } = view(series, direction, active);
  const routeCount = chips.length ? series.filter((s) => s.direction === direction).length : 0;
  const hours = series[0]?.hours.map((h) => h.hour) ?? [];
  const computed = lines.map((l) => ({ ...l, ps: points(l.series) }));

  // End labels: one per line, plus the band's own, pushed apart together.
  const ends = computed.map((l) => { const k = lastIndex(l.ps); return k < 0 ? null : { k, v: l.ps[k]! }; });
  const bandTop = band ? lastIndex(band.hi) : -1;
  const wanted: number[] = [];
  ends.forEach((e) => { if (e) wanted.push(y(e.v) + 4); });
  if (band && bandTop >= 0) wanted.push(y(band.hi[bandTop]!) + 16);
  const spread = spreadLabels(wanted, 14);
  let cursor = 0;
  const labelY = ends.map((e) => (e ? spread[cursor++]! : null));
  const bandLabelY = band && bandTop >= 0 ? spread[cursor] : undefined;

  const move = (ev: React.MouseEvent<SVGRectElement>) => {
    const svg = ev.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const sx = ((ev.clientX - svg.left) * W) / svg.width;
    const i = Math.max(0, Math.min(N - 1, Math.round((sx - L) / (PW / (N - 1)))));
    const host = box.current!.getBoundingClientRect();
    let left = ev.clientX - host.left + 14;
    if (left > host.width - 280) left -= 300;
    setHover({ i, left, top: ev.clientY - host.top - 20 });
  };

  const tipValues = hover && band ? [band.lo[hover.i], band.hi[hover.i]] : [];
  const tipLo = tipValues[0], tipHi = tipValues[1];

  return (
    <div className="card route-chart" ref={box}>
      <div className="rc-head">
        <div>
          <h2>{t('home.chart.title')}</h2>
          <div className="muted small">{t('home.chart.subtitle')}</div>
        </div>
        <span className="seg">
          {(['collection', 'disbursement'] as const).map((d) => (
            <button key={d} type="button" aria-pressed={direction === d} onClick={() => { setDirection(d); setCountry('all'); }}>{t(`home.chart.${d}`)}</button>
          ))}
        </span>
      </div>
      <div className="chips">
        <button type="button" className="chip" aria-pressed={active === 'all'} onClick={() => setCountry('all')}>{t('home.chart.all', { n: routeCount })}</button>
        {chips.map((c) => (
          <button key={c.country} type="button" className="chip" aria-pressed={active === c.country} onClick={() => setCountry(c.country)}>
            {c.country}{c.departing > 0 && <span className="departing">● {c.departing}</span>}
          </button>
        ))}
      </div>
      {routeCount === 0 ? <p className="muted">{t('home.chart.empty')}</p> : (
        <>
          <div className="legend">
            {computed.map((l) => (
              <span key={l.series.route_id}>
                <i style={{ background: l.dashed ? `repeating-linear-gradient(90deg, ${operatorColour(l.series.payment_method_code)} 0 4px, transparent 4px 7px)` : operatorColour(l.series.payment_method_code) }} />{l.label}
              </span>
            ))}
            {band && <span><i className="band" />{t('home.chart.legend_band')}</span>}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('home.chart.title')} onMouseLeave={() => setHover(null)}>
            {GRID.map((v) => (
              <g key={v}>
                <line className={v === 0.5 ? 'grid floor' : 'grid'} x1={L} x2={L + PW} y1={y(v)} y2={y(v)} />
                <text className="axis" x={L - 6} y={y(v) + 4} textAnchor="end">{Math.round(v * 100)} %</text>
              </g>
            ))}
            {hours.map((h, i) => (i % 4 === 3 || i === N - 1) && (
              <text key={h} className="axis" x={x(i)} y={H - 6} textAnchor="middle">{i === N - 1 ? t('home.chart.now') : hourLabel(h)}</text>
            ))}
            {band && <path className="band-fill" d={bandPath(band.lo, band.hi)} />}
            {band && bandLabelY !== undefined && <text x={x(N - 1) + 10} y={bandLabelY}>{t('home.chart.others', { n: band.count })}</text>}
            {computed.map((l) => (
              <path key={l.series.route_id} d={linePath(l.ps)} fill="none" stroke={operatorColour(l.series.payment_method_code)} strokeWidth={2}
                strokeDasharray={l.dashed ? '6 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {computed.map((l, n) => {
              const e = ends[n], ly = labelY[n];
              if (!e || ly == null) return null;
              return (
                <g key={l.series.route_id}>
                  <circle className="end-dot" cx={x(e.k)} cy={y(e.v)} r={4} fill={operatorColour(l.series.payment_method_code)} />
                  <text x={x(N - 1) + 10} y={ly}>{l.label} <tspan fontWeight={700}>{whole(e.v)} %</tspan></text>
                </g>
              );
            })}
            {hover && <line className="crosshair" x1={x(hover.i)} x2={x(hover.i)} y1={T} y2={T + PH} />}
            <rect x={L} y={T} width={PW} height={PH} fill="transparent" onMouseMove={move} />
          </svg>
          {hover && (
            <div className="tip" style={{ left: hover.left, top: hover.top }}>
              <b>{hours[hover.i] ? hourLabel(hours[hover.i]!) : ''}</b>
              {computed.map((l) => {
                const v = l.ps[hover.i], h = l.series.hours[hover.i];
                return (
                  <div key={l.series.route_id}>
                    <span className="swatch" style={{ background: operatorColour(l.series.payment_method_code) }} />{l.label} <span className="num">{v == null ? '—' : `${(v * 100).toFixed(1)} %`}</span>
                    <span className="k"> · {t('home.chart.tx', { n: h?.terminal ?? 0 })}{l.series.baseline != null && ` · ${t('home.chart.baseline', { pct: whole(l.series.baseline) })}`}</span>
                  </div>
                );
              })}
              {band && tipLo != null && tipHi != null && (
                <div className="k">{t('home.chart.others_range', { n: band.count, lo: whole(tipLo), hi: whole(tipHi) })}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
