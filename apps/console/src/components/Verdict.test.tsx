import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Problem } from '../lib/home';
import { Verdict } from './Verdict';

const loadedAt = new Date();
const render = (problems: Problem[]) => renderToStaticMarkup(<MemoryRouter><Verdict problems={problems} loadedAt={loadedAt} /></MemoryRouter>);
const critical: Problem = { severity: 'critical', kind: 'health:success_rate:route', subject_type: 'route', subject_reference: 'r1', subject_name: 'Orange Money CI · collection', count: 1, since: loadedAt.toISOString(), title: 't', link: '/oversight/alerts/42' };

describe('Verdict', () => {
  it('is confirmed without problems', () => {
    const html = render([]);
    expect(html).toContain('verdict confirmed');
    expect(html).toContain('Everything is running normally');
  });
  it('is refused with a critical problem, and links to it', () => {
    const html = render([critical]);
    expect(html).toContain('verdict refused');
    expect(html).toContain('href="/oversight/alerts/42"');
    expect(html).toContain('Orange Money CI · collection is failing');
  });
});
