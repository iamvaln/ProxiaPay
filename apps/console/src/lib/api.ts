/** Console API client. Every mutating call carries the header the server requires as its cross-site guard. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>, readonly field?: string) {
    super(message);
  }
}

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
