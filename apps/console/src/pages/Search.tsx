import { Link, useSearchParams } from 'react-router-dom';
import { get } from '../lib/api';
import { Empty, ErrorLine, Pill, useLoad } from '../components/common';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const { data, error } = useLoad(() => get<{ results: any[] }>(`/search?q=${encodeURIComponent(q)}`), [q]);
  return (
    <>
      <h1>Search: {q}</h1>
      <ErrorLine error={error} />
      {data && (data.results.length === 0 ? <Empty text="No record matches that reference." /> : (
        <table><thead><tr><th>Kind</th><th>Reference</th><th>State</th></tr></thead>
          <tbody>{data.results.map((r) => <tr key={r.kind + r.id}><td>{r.kind}</td><td>{r.kind === 'transaction' ? <Link to={`/transactions/${r.reference}`}>{r.reference}</Link> : <Link to={`/transactions/previews?reference=${r.reference}`}>{r.reference}</Link>}</td><td><Pill value={r.state} /></td></tr>)}</tbody></table>
      ))}
    </>
  );
}
