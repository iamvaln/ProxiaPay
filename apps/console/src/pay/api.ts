/**
 * The payment page's only way out: the public pay API. Nothing here reaches the console's API, carries a credential
 * or sends a cookie the page set; every call is relative, so one bundle serves every environment.
 */
const BASE = '/pay-api/v1';

export interface LinkMethod { key: string; country: string; name: string; minimum_amount: number; maximum_amount: number; charged_amount?: number }
export interface LinkView {
  code: string;
  project_name: string;
  title: string;
  description: string | null;
  amount_type: 'fixed' | 'free';
  amount: number | null;
  minimum_amount: number;
  currency: string;
  exponent: number;
  sandbox: boolean;
  brand: { logo_url: string | null; primary_color: string; secondary_color: string | null };
  countries: { code: string; name: string; dialling_prefix: string }[];
  methods: LinkMethod[];
}
export interface Quote { charged_amount: number; fees_borne_by_payer: number }
export interface Review {
  amount: number;
  fees_borne_by_payer: number;
  total: number;
  currency: string;
  method: { country: string; name: string };
  msisdn_formatted: string;
  expires_at: string;
}
export interface PaymentStatus {
  state: string;
  reference: string;
  amount: number;
  charged_amount: number;
  currency: string;
  method: { country: string; name: string };
  instructions: string | null;
  outcome: { failure_reason_text: string | null } | null;
  /** The receipt's facts, carried by the payment so a reload keeps them once the link is gone. */
  project_name: string;
  title: string;
  exponent: number;
  sandbox: boolean;
  msisdn_masked: string;
  completed_at: string | null;
  brand: { logo_url: string | null; primary_color: string };
}

/**
 * The platform's error body, kept whole: the page words some codes itself and shows a field's message beside the field.
 * `answered` says the platform's own error body came back, not a gateway's page or an empty answer.
 */
export class PayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string, readonly answered = true) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!res.ok) {
    const answered = typeof data?.error === 'object' && data.error !== null;
    const e = answered ? data.error : {};
    throw new PayError(res.status, e.code ?? (res.status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR'), e.message ?? res.statusText, e.field, answered);
  }
  return data as T;
}

const seg = encodeURIComponent;

export const getLink = (code: string) => call<LinkView>(`/links/${seg(code)}`);
export const quote = (code: string, method: string, amount: number) => call<Quote>(`/links/${seg(code)}/quote`, { method, amount });
export const createPreview = (code: string, input: { method: string; msisdn: string; amount?: number }) =>
  call<{ payment_token: string; review: Review }>(`/links/${seg(code)}/previews`, input);
export const confirmPayment = (token: string) => call<{ reference: string }>(`/payments/${seg(token)}/confirm`, {});
export const getPayment = (token: string, lang: 'en' | 'fr') => call<PaymentStatus>(`/payments/${seg(token)}?lang=${lang}`);
export const sendReceipt = (token: string, email: string, language: 'en' | 'fr') => call<{ status: 'sent' | 'failed' }>(`/payments/${seg(token)}/receipt`, { email, language });
