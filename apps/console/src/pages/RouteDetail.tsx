import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, ErrorLine, NeedsPermission, Pill, When, useLoad } from '../components/common';

/** Route detail (console spec 7.2): the current version, projects with their own rates, the version history as a sequence, and opening a new version with its comparison. */
export function RouteDetailPage() {
  const { id } = useParams();
  const { has } = useSession();
  const { data, error, reload } = useLoad(() => get<any>(`/configuration/routes/${id}`), [id]);
  const [draft, setDraft] = useState<any>(null);
  const [cmp, setCmp] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const r = data.route, c = data.current;
  const startDraft = () => setDraft({
    processing_fee_bps: c.processing_fee_bps, processing_fee_fixed: c.processing_fee_fixed, platform_fee_bps: c.platform_fee_bps, platform_fee_fixed: c.platform_fee_fixed,
    processing_fee_bearer: c.processing_fee_bearer, platform_fee_bearer: c.platform_fee_bearer, minimum_amount: c.minimum_amount, maximum_amount: c.maximum_amount,
    otp_required: c.otp_required, browser_required: c.browser_required, disbursement_fallback: c.disbursement_fallback, active: c.active,
    bindings: c.bindings.map((b: any) => ({ provider_account_id: b.provider_account_id, expected_fee_bps: b.expected_fee_bps, expected_fee_fixed: b.expected_fee_fixed, terms_status: b.terms_status, enabled: b.enabled, minimum_amount: b.minimum_amount, maximum_amount: b.maximum_amount })),
    note: '', accept_shortfall: false,
  });
  const compare = async () => { setErr(null); try { setCmp(await post(`/configuration/routes/${id}/versions/compare`, draft)); } catch (e) { setErr((e as Error).message); } };
  const commit = async () => { setErr(null); try { await post(`/configuration/routes/${id}/versions`, draft); setDraft(null); setCmp(null); reload(); } catch (e: any) { setErr(e.details?.warnings ? `${e.message} ${e.details.warnings.map((w: any) => `shortfall ${w.shortfall_per_10000} per 10,000`).join('; ')}` : e.message); } };
  return (
    <>
      <h1>{r.country_code} · {r.payment_method_code} · {r.direction} · {r.currency_code}</h1>
      <div className="grid2">
        <div className="card">
          <h2>Current version #{c.sequence} <Pill value={c.active ? 'active' : 'suspended'} /></h2>
          <dl className="kv">
            <dt>Processing fee</dt><dd>{c.processing_fee_bps / 100}% + {c.processing_fee_fixed} · borne by {c.processing_fee_bearer}</dd>
            <dt>Platform fee</dt><dd>{c.platform_fee_bps / 100}% + {c.platform_fee_fixed} · borne by {c.platform_fee_bearer}</dd>
            <dt>Amount limits</dt><dd>{c.minimum_amount} – {c.maximum_amount} {r.currency_code}</dd>
            <dt>Payer interaction</dt><dd>{c.otp_required ? 'one-time code' : c.browser_required ? 'browser step' : 'none'}</dd>
            <dt>Disbursement fallback</dt><dd>{c.disbursement_fallback ? 'enabled' : 'disabled'}</dd>
            <dt>Valid from</dt><dd><When value={c.valid_from} /> {c.author ? `by ${c.author}` : '(seed)'}</dd>
            <dt>Note</dt><dd>{c.note}</dd><dt>Fingerprint</dt><dd className="small muted">{c.fingerprint}</dd>
          </dl>
          <h3>Bindings, in fallback order</h3>
          <table><thead><tr><th>#</th><th>Provider account</th><th className="num">Expected fee</th><th>Terms</th><th>Enabled</th><th>Limits</th></tr></thead>
            <tbody>{c.bindings.map((b: any) => <tr key={b.id}><td>{b.priority}</td><td><Link to={`/configuration/providers/${b.provider_account_id}`}>{b.provider_account_name}</Link> <Pill value={b.provider_account_status} /></td><td className="num">{b.expected_fee_bps / 100}%{b.expected_fee_bps > c.processing_fee_bps && <span className="pill critical" title="Expected provider fee exceeds the processing fee">below cost</span>}</td><td><Pill value={b.terms_status} /></td><td>{b.enabled ? 'yes' : 'no'}</td><td className="small">{b.minimum_amount ?? '—'} / {b.maximum_amount ?? '—'}</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <h2>Projects quoted their own rates</h2>
          {data.projects_with_overrides.length === 0 ? <Empty text="Every project on this route pays the route's own terms." /> : <table><tbody>{data.projects_with_overrides.map((p: any) => <tr key={p.id}><td><Link to={`/projects/${p.id}`}>{p.name}</Link></td><td className="small">processing {p.processing_fee_bps != null ? `${p.processing_fee_bps / 100}%` : 'route'} · platform {p.platform_fee_bps != null ? `${p.platform_fee_bps / 100}%` : 'route'} · bearers {p.processing_fee_bearer ?? 'route'}/{p.platform_fee_bearer ?? 'route'}</td></tr>)}</tbody></table>}
          <h2>Version history</h2>
          <ul>{data.versions.map((v: any) => <li key={v.id}>#{v.sequence} · <When value={v.valid_from} /> → {v.valid_to ? <When value={v.valid_to} /> : 'open'} {v.author ? `· ${v.author}` : ''} · <i>{v.note}</i>{Object.keys(v.changes_from_previous).length > 0 && <div className="diff">{Object.entries(v.changes_from_previous).map(([k, ch]: any) => <div key={k}>{k}: {String(ch.from)} → {String(ch.to)}</div>)}</div>}</li>)}</ul>
        </div>
      </div>
      <div className="card">
        <h2>Open a new version</h2>
        <p className="small muted">Existing versions are never altered; transactions refer to the terms that were true at the time.</p>
        {!has('routes.open_version') ? <NeedsPermission permission="routes.open_version" /> : !draft ? <button onClick={startDraft}>Open a new version</button> : (
          <form className="stack" style={{ maxWidth: 900 }} onSubmit={(e) => { e.preventDefault(); void compare(); }}>
            <div className="row">
              <label>Processing bps<input type="number" value={draft.processing_fee_bps} onChange={(e) => setDraft({ ...draft, processing_fee_bps: Number(e.target.value) })} disabled={!has('routes.set_fees')} /></label>
              <label>Platform bps<input type="number" value={draft.platform_fee_bps} onChange={(e) => setDraft({ ...draft, platform_fee_bps: Number(e.target.value) })} disabled={!has('routes.set_fees')} /></label>
              <label>Processing bearer<select value={draft.processing_fee_bearer} onChange={(e) => setDraft({ ...draft, processing_fee_bearer: e.target.value })}><option>counterparty</option><option>project</option></select></label>
              <label>Platform bearer<select value={draft.platform_fee_bearer} onChange={(e) => setDraft({ ...draft, platform_fee_bearer: e.target.value })}><option>counterparty</option><option>project</option></select></label>
              <label>Minimum<input type="number" value={draft.minimum_amount} onChange={(e) => setDraft({ ...draft, minimum_amount: Number(e.target.value) })} /></label>
              <label>Maximum<input type="number" value={draft.maximum_amount} onChange={(e) => setDraft({ ...draft, maximum_amount: Number(e.target.value) })} /></label>
            </div>
            <div className="row">
              <label><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> active</label>
              <label><input type="checkbox" checked={draft.otp_required} onChange={(e) => setDraft({ ...draft, otp_required: e.target.checked, browser_required: false })} /> one-time code</label>
              <label><input type="checkbox" checked={draft.browser_required} onChange={(e) => setDraft({ ...draft, browser_required: e.target.checked, otp_required: false })} /> browser step</label>
              <label><input type="checkbox" checked={draft.disbursement_fallback} onChange={(e) => setDraft({ ...draft, disbursement_fallback: e.target.checked })} /> disbursement fallback</label>
            </div>
            <h3>Bindings (order is fallback order)</h3>
            {draft.bindings.map((b: any, i: number) => <div className="row" key={i}>
              <span className="small muted">#{i + 1}</span>
              <label>Expected bps<input type="number" value={b.expected_fee_bps} onChange={(e) => { const bs = [...draft.bindings]; bs[i] = { ...b, expected_fee_bps: Number(e.target.value) }; setDraft({ ...draft, bindings: bs }); }} /></label>
              <label>Terms<select value={b.terms_status} onChange={(e) => { const bs = [...draft.bindings]; bs[i] = { ...b, terms_status: e.target.value }; setDraft({ ...draft, bindings: bs }); }}><option>indicative</option><option>contracted</option></select></label>
              <label><input type="checkbox" checked={b.enabled} onChange={(e) => { const bs = [...draft.bindings]; bs[i] = { ...b, enabled: e.target.checked }; setDraft({ ...draft, bindings: bs }); }} /> enabled</label>
              {i > 0 && <button type="button" onClick={() => { const bs = [...draft.bindings]; [bs[i - 1], bs[i]] = [bs[i], bs[i - 1]]; setDraft({ ...draft, bindings: bs }); }}>↑</button>}
            </div>)}
            <label>Note (required)<input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} required /></label>
            <label className="row"><input type="checkbox" checked={draft.accept_shortfall} onChange={(e) => setDraft({ ...draft, accept_shortfall: e.target.checked })} /> Accept a binding expected to charge more than the route recovers</label>
            <div className="row"><button>Show comparison</button><button type="button" onClick={() => { setDraft(null); setCmp(null); }}>Cancel</button></div>
            {cmp && <div className="warnbox">
              <b>What changes</b>
              {Object.keys(cmp.changes).length === 0 ? <p className="muted small">Nothing differs from the current version.</p> : <div className="diff">{Object.entries(cmp.changes).map(([k, ch]: any) => <div key={k}>{k}: {String(ch.from)} → {String(ch.to)}</div>)}</div>}
              {cmp.warnings.length > 0 && <p className="negative small">Below cost: {cmp.warnings.map((w: any) => `provider expects ${w.expected_fee_bps / 100}% against ${w.processing_fee_bps / 100}% recovered, shortfall ${w.shortfall_per_10000} per 10,000`).join('; ')}</p>}
              <p className="small">{cmp.in_flight} transactions in flight complete under the terms they began with.</p>
              <button type="button" className="primary" onClick={commit}>Commit version #{c.sequence + 1}</button>
            </div>}
            <ErrorLine error={err} />
          </form>
        )}
      </div>
    </>
  );
}
