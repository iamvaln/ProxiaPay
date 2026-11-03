// Pure rules behind the console home: how open alerts become the verdict's problems, and when a route departs from its baseline.

export interface AlertRow {
  id: string;
  severity: 'informational' | 'warning' | 'critical';
  category: string;
  subject_type: string;
  subject_reference: string;
  fingerprint: string;
  title: string;
  action_reference: string;
  raised_at: Date;
}

export interface Problem {
  severity: 'warning' | 'critical';
  kind: string;
  subject_type: string;
  subject_reference: string | null;
  subject_name: string | null;
  count: number;
  since: string;
  title: string;
  link: string;
}

// `health:success_rate:<dimension>` keeps its dimension (a route and a project are different problems); the others are named by their first segment.
export function alertKind(fingerprint: string): string {
  const parts = fingerprint.split(':');
  return parts[0] === 'health' ? parts.slice(0, 3).join(':') : parts[0]!;
}

// One alert per transaction or payer would drown the verdict, so those collapse by kind; everything else is one problem per subject.
const COLLAPSED_SUBJECTS = new Set(['transaction', 'payer']);

export function groupProblems(alerts: AlertRow[], names: Map<string, string>): Problem[] {
  const groups = new Map<string, AlertRow[]>();
  for (const a of alerts) {
    if (a.severity === 'informational') continue;
    const kind = alertKind(a.fingerprint);
    const key = COLLAPSED_SUBJECTS.has(a.subject_type) ? kind : `${kind}|${a.subject_type}|${a.subject_reference}`;
    const group = groups.get(key);
    if (group) group.push(a);
    else groups.set(key, [a]);
  }

  const problems = [...groups.values()].map((group) => {
    const sorted = [...group].sort((x, y) => x.raised_at.getTime() - y.raised_at.getTime());
    const oldest = sorted[0]!;
    const kind = alertKind(oldest.fingerprint);
    const collapsed = COLLAPSED_SUBJECTS.has(oldest.subject_type);
    return {
      severity: group.some((a) => a.severity === 'critical') ? 'critical' : 'warning',
      kind,
      subject_type: oldest.subject_type,
      subject_reference: collapsed ? null : oldest.subject_reference,
      subject_name: collapsed ? null : (names.get(`${oldest.subject_type}:${oldest.subject_reference}`) ?? oldest.subject_reference),
      count: group.length,
      since: oldest.raised_at.toISOString(),
      title: oldest.title,
      link: kind === 'undetermined' ? '/transactions?state=undetermined' : oldest.action_reference,
    } satisfies Problem;
  });

  return problems.sort((x, y) => {
    if (x.severity !== y.severity) return x.severity === 'critical' ? -1 : 1;
    return Date.parse(x.since) - Date.parse(y.since);
  });
}

// A route departs when it has an open alert, or sits 5 points under its own baseline on a sample big enough to mean it.
export const DEPARTING = { margin: 0.05, minSample: 20 } as const;

export function isDeparting(r: { current: number | null; baseline: number | null; sample: number; alerted: boolean }): boolean {
  if (r.alerted) return true;
  if (r.current === null || r.baseline === null || r.sample < DEPARTING.minSample) return false;
  return r.baseline - r.current >= DEPARTING.margin - 1e-9;
}
