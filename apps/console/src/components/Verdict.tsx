import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Problem } from '../lib/home';
import { useSession, useT } from '../lib/session';
import { headline, problemText, verdictState } from '../lib/verdict';
import { useEvery } from './common';

/** The home's one sentence: a state colour, a headline counting problems, each problem in plain words (most severe first), and how fresh it is. */
export function Verdict({ problems, loadedAt }: { problems: Problem[]; loadedAt: Date }) {
  const t = useT();
  const { lang } = useSession();
  const [now, setNow] = useState(() => Date.now());
  useEvery(() => setNow(Date.now()), 1000);
  const ordered = [...problems].sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  const seconds = Math.max(0, Math.floor((now - loadedAt.getTime()) / 1000));
  return (
    <section className={`verdict ${verdictState(problems)}`}>
      <h2 className="verdict-headline">{headline(problems, lang)}</h2>
      {ordered.length > 0 && (
        <p className="verdict-subject">
          {ordered.map((p, i) => (
            <Fragment key={`${p.kind}:${p.subject_reference ?? p.subject_name ?? i}`}>
              {i > 0 && ' · '}
              <Link to={p.link}>{problemText(p, lang)}</Link>
            </Fragment>
          ))}
        </p>
      )}
      <p className="verdict-updated small">{t('home.verdict.updated', { seconds })}</p>
    </section>
  );
}
