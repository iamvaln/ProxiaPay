import { Link, useSearchParams } from 'react-router-dom';
import { get } from '../lib/api';
import { useT } from '../lib/session';
import { ErrorLine, Pill, useLoad } from '../components/common';
import { DataTable } from '../components/table/DataTable';

type Hit = { kind: 'transaction' | 'preview'; id: string; reference: string; state: string };
export type SearchData = { transactions: Omit<Hit, 'kind'>[]; previews: Omit<Hit, 'kind'>[]; capped: boolean };

/** A payer-number search shows its hits but links to no list: a number never goes into a URL. */
const looksLikeNumber = (q: string) => /^\+?\d{6,15}$/.test(q.replace(/[\s().-]/g, ''));

/** The lookup's hits as a results page (not a list: it stops at its cap and says so). */
export function SearchResults({ q, data }: { q: string; data: SearchData }) {
  const t = useT();
  const byNumber = looksLikeNumber(q);
  const hits: Hit[] = [...data.transactions.map((r) => ({ ...r, kind: 'transaction' as const })), ...data.previews.map((r) => ({ ...r, kind: 'preview' as const }))];
  return (
    <>
      {data.capped && <p className="warnbox">{t('l.search_capped')}</p>}
      <DataTable<Hit> bare rows={hits} rowKey={(r) => r.kind + r.id} defaultSort="reference" empty={{ none: t('l.search_none'), why: t('l.search_why') }}
        columns={[
          { key: 'kind', label: t('l.kind'), render: (r) => t(`l.kind_${r.kind}`) },
          { key: 'reference', label: t('col.reference'), mono: true, render: (r) => r.kind === 'transaction'
            ? <Link to={`/transactions/${r.reference}`}>{r.reference}</Link>
            : byNumber ? r.reference : <Link to={`/transactions/previews?q=${encodeURIComponent(r.reference)}`}>{r.reference}</Link> },
          { key: 'state', label: t('col.state'), render: (r) => <Pill value={r.state} /> },
        ]} />
    </>
  );
}

export function SearchPage() {
  const t = useT();
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const { data, error } = useLoad(() => get<SearchData>(`/search?q=${encodeURIComponent(q)}`), [q]);
  return (
    <>
      <h1>{t('l.search_title', { q: looksLikeNumber(q) ? '' : q })}</h1>
      <ErrorLine error={error} />
      {data && <SearchResults q={q} data={data} />}
    </>
  );
}
