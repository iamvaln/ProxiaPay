/** Console API client. Every mutating call carries the header the server requires as its cross-site guard. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>, readonly field?: string) {
    super(message);
  }
}

/** Fires when the server says the session is gone (idle or absolute expiry, sign-out elsewhere), so the console returns to sign-in. */
export const sessionEvents = new EventTarget();
export const SESSION_ENDED = 'session-ended';

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`/console${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'ProxiaPay', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 304) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && e.code === 'UNAUTHENTICATED') sessionEvents.dispatchEvent(new Event(SESSION_ENDED));
    throw new ApiError(res.status, e.code ?? 'INTERNAL_ERROR', e.message ?? res.statusText, e.details, e.field);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const put = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const patch = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: body ?? {} });
export const del = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'DELETE', body: body ?? {} });

/** Requests a one-time code bound to the values, and returns the confirmation identifier the operation call must carry. */
export async function requestConfirmation(operationType: string, values: unknown, subjectReference?: string): Promise<{ confirmation_id: string; expires_at: string }> {
  return post('/auth/confirmations', { operation_type: operationType, values, subject_reference: subjectReference });
}

/** The fields a console form sends, named in words, with what a valid value looks like (i18n `field.*` and `expect.*`). */
const FIELDS: Record<string, string> = {
  processing_fee_bps: 'bps', platform_fee_bps: 'bps', count_24h: 'count', count_30d: 'count', value_24h: 'minor', value_30d: 'minor',
  processing_fee_bearer: 'bearer', platform_fee_bearer: 'bearer', route_id: 'route', note: 'note', code: 'code', name: 'name',
  cidr: 'cidr', description: 'description', url: 'url',
};

/**
 * What an administrator reads when a request fails. A validation error the console knows the field of becomes a
 * sentence naming the field and what it expects; anything else keeps the server's message.
 */
export function readableError(err: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (err instanceof ApiError && err.code === 'FIELD_INVALID' && err.field && FIELDS[err.field]) {
    return t('err.field', { field: t(`field.${err.field}`), expect: t(`expect.${FIELDS[err.field]}`) });
  }
  return err instanceof Error ? err.message : String(err);
}
