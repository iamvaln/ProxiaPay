import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { previewSchema } from '../transactions/preview.service';
import { listQuerySchema } from '../project-api/transaction-list';
import { REQUEST_ERRORS, FAILURE_REASONS } from '../common/errors';

/**
 * Generates the machine-readable interface specification of spec 7.5 from the request schemas
 * the implementation validates with, so the document describes the interface as it is.
 * Usage: npm run openapi -- [--env production|sandbox] [--out openapi.json]
 */
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : [])).filter((p) => p.length)) as Record<string, string>;
const env = args.env === 'production' ? 'production' : 'sandbox';
const server = env === 'production' ? 'https://pay.proxia-digital.com/v1' : 'https://sandbox.pay.proxia-digital.com/v1';

const errorSchema = { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'retryable'], properties: { code: { type: 'string', enum: Object.keys(REQUEST_ERRORS) }, message: { type: 'string' }, field: { type: 'string' }, retryable: { type: 'boolean' }, details: { type: 'object', additionalProperties: true } } } } };
const fee = { type: 'object', required: ['amount', 'bearer'], properties: { amount: { type: 'integer' }, bearer: { type: 'string', enum: ['counterparty', 'project'] } } };
const fees = { type: 'object', required: ['processing', 'platform', 'total'], properties: { processing: fee, platform: fee, total: { type: 'integer' } } };
const route = { type: 'object', properties: { country: { type: 'string' }, payment_method: { type: 'string' }, direction: { type: 'string', enum: ['collection', 'disbursement'] } } };
const transaction = {
  type: 'object',
  properties: {
    reference: { type: 'string', example: 'txn_01J8XQ3R7T' }, project_reference: { type: 'string' }, provider_reference: { type: 'string', nullable: true }, operator_reference: { type: 'string', nullable: true },
    direction: { type: 'string', enum: ['collection', 'disbursement'] }, state: { type: 'string', enum: ['created', 'action_required', 'submitted', 'processing', 'succeeded', 'failed', 'expired', 'undetermined'] },
    reconciliation_status: { type: 'string', enum: ['unreviewed', 'matched', 'disputed', 'examined', 'corrected'] }, currency: { type: 'string' }, requested_amount: { type: 'integer' }, charged_amount: { type: 'integer' }, settled_amount: { type: 'integer', nullable: true },
    fees, route, counterparty: { type: 'object', properties: { msisdn: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } },
    action: { type: 'object', nullable: true, properties: { type: { type: 'string', enum: ['code', 'browser'] }, url: { type: 'string' }, attempts_remaining: { type: 'integer' }, expires_at: { type: 'string', format: 'date-time' } } },
    failure_reason: { type: 'string', nullable: true, enum: [...FAILURE_REASONS, null] }, metadata: { type: 'object', additionalProperties: true }, created_at: { type: 'string', format: 'date-time' }, terminal_at: { type: 'string', format: 'date-time', nullable: true },
  },
};
const preview = { type: 'object', properties: { reference: { type: 'string', example: 'prv_01J8XQ2M4K' }, direction: { type: 'string' }, currency: { type: 'string' }, requested_amount: { type: 'integer' }, charged_amount: { type: 'integer' }, settled_amount: { type: 'integer' }, fees, route, counterparty: { type: 'object', properties: { msisdn: { type: 'string' }, name: { type: 'string' } } }, payer_action: { type: 'string', enum: ['none', 'code', 'browser'] }, project_reference: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' } } };

const errors = (codes: string[]) => Object.fromEntries([...new Set(codes.map((c) => String(REQUEST_ERRORS[c as keyof typeof REQUEST_ERRORS].status)))].map((s) => [s, { description: codes.filter((c) => String(REQUEST_ERRORS[c as keyof typeof REQUEST_ERRORS].status) === s).join(', '), content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }]));
const authErrors = ['TOKEN_INVALID', 'TOKEN_EXPIRED', 'ORIGIN_NOT_ALLOWED', 'RATE_LIMITED'];
const json = (schema: unknown) => ({ 'application/json': { schema } });
const toJson = (s: z.ZodType) => z.toJSONSchema(s, { target: 'openapi-3.0' });

const doc = {
  openapi: '3.0.3',
  info: { title: 'ProxiaPay', version: '1.0.0', description: `Project interface, ${env} environment. Amounts are integers in minor units; timestamps are RFC 3339 in UTC. Every response carries X-Request-Id and the X-RateLimit-* headers.` },
  servers: [{ url: server }],
  security: [{ bearer: [] }],
  paths: {
    '/auth/tokens': { post: { summary: 'Exchange credentials for a token', security: [], requestBody: { content: json({ type: 'object', required: ['client_key', 'client_secret'], properties: { client_key: { type: 'string' }, client_secret: { type: 'string' } } }) }, responses: { 200: { description: 'Token', content: json({ type: 'object', properties: { access_token: { type: 'string' }, token_type: { type: 'string', enum: ['Bearer'] }, expires_in: { type: 'integer' } } }) }, ...errors(['CREDENTIALS_INVALID', 'CREDENTIALS_REVOKED', 'ORIGIN_NOT_ALLOWED', 'RATE_LIMITED']) } } },
    '/previews': { post: { summary: 'Create a preview', requestBody: { content: json(toJson(previewSchema)) }, responses: { 201: { description: 'Preview', content: json({ $ref: '#/components/schemas/Preview' }) }, ...errors([...authErrors, 'SCOPE_INSUFFICIENT', 'FIELD_INVALID', 'AMOUNT_INVALID', 'CURRENCY_UNKNOWN', 'COUNTRY_UNKNOWN', 'PAYMENT_METHOD_UNKNOWN', 'PAYER_IDENTIFIER_INVALID', 'COUNTRY_DISABLED', 'ROUTE_UNAVAILABLE', 'ROUTE_DISABLED', 'ENTITLEMENT_MISSING', 'ENTITLEMENT_DISABLED', 'AMOUNT_BELOW_MINIMUM', 'AMOUNT_ABOVE_MAXIMUM', 'REFERENCE_CONFLICT', 'SIMILAR_PAYMENT_PENDING']) } } },
    '/collections': { post: { summary: 'Confirm a collection', requestBody: { content: json({ type: 'object', required: ['preview_reference'], properties: { preview_reference: { type: 'string' } } }) }, responses: { 201: { description: 'Transaction created', content: json({ $ref: '#/components/schemas/Transaction' }) }, 200: { description: 'Transaction already created by an earlier confirmation', content: json({ $ref: '#/components/schemas/Transaction' }) }, ...errors([...authErrors, 'SCOPE_INSUFFICIENT', 'PREVIEW_NOT_FOUND', 'PREVIEW_EXPIRED', 'PREVIEW_DIRECTION_MISMATCH', 'SIMILAR_PAYMENT_PENDING', 'VELOCITY_COUNT_EXCEEDED', 'VELOCITY_VALUE_EXCEEDED', 'NO_PROVIDER_AVAILABLE']) } } },
    '/disbursements': { post: { summary: 'Confirm a disbursement', requestBody: { content: json({ type: 'object', required: ['preview_reference'], properties: { preview_reference: { type: 'string' } } }) }, responses: { 201: { description: 'Transaction created', content: json({ $ref: '#/components/schemas/Transaction' }) }, 200: { description: 'Already created', content: json({ $ref: '#/components/schemas/Transaction' }) }, ...errors([...authErrors, 'SCOPE_INSUFFICIENT', 'PREVIEW_NOT_FOUND', 'PREVIEW_EXPIRED', 'PREVIEW_DIRECTION_MISMATCH', 'SIMILAR_PAYMENT_PENDING', 'VELOCITY_COUNT_EXCEEDED', 'VELOCITY_VALUE_EXCEEDED', 'BALANCE_INSUFFICIENT', 'FLOAT_INSUFFICIENT', 'NO_PROVIDER_AVAILABLE']) } } },
    '/transactions/{reference}/code': { post: { summary: 'Submit a one-time code', parameters: [{ name: 'reference', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: json({ type: 'object', required: ['code'], properties: { code: { type: 'string' } } }) }, responses: { 200: { description: 'Transaction', content: json({ $ref: '#/components/schemas/Transaction' }) }, ...errors([...authErrors, 'TRANSACTION_NOT_FOUND', 'ACTION_NOT_AVAILABLE', 'CODE_INVALID', 'CODE_ATTEMPTS_EXHAUSTED']) } } },
    '/transactions/{reference}': { get: { summary: 'Retrieve a transaction', parameters: [{ name: 'reference', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Transaction', content: json({ $ref: '#/components/schemas/Transaction' }) }, ...errors([...authErrors, 'TRANSACTION_NOT_FOUND']) } } },
    '/transactions': { get: { summary: 'List transactions', parameters: Object.entries((toJson(listQuerySchema) as { properties: Record<string, unknown> }).properties).map(([name, schema]) => ({ name, in: 'query', schema })), responses: { 200: { description: 'Page', content: json({ type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } }, next_cursor: { type: 'string', nullable: true }, has_more: { type: 'boolean' } } }) }, ...errors(authErrors) } } },
    '/settings': { get: { summary: 'Retrieve settings', description: 'Carries ETag; If-None-Match returns 304 where unchanged.', responses: { 200: { description: 'Settings', content: json({ type: 'object', properties: { fingerprint: { type: 'string' }, currencies: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, exponent: { type: 'integer' } } } }, routes: { type: 'array', items: { type: 'object', additionalProperties: true } } } }) }, 304: { description: 'Unchanged' }, ...errors(authErrors) } } },
    '/balances': { get: { summary: 'Retrieve balances', responses: { 200: { description: 'Balances', content: json({ type: 'object', properties: { balances: { type: 'array', items: { type: 'object', properties: { currency: { type: 'string' }, available: { type: 'integer' }, reserved: { type: 'integer' } } } } } }) }, ...errors(authErrors) } } },
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: { Error: errorSchema, Transaction: transaction, Preview: preview } },
  'x-notifications': {
    description: 'HTTP POST to the registered address with headers X-ProxiaPay-Event-Id, X-ProxiaPay-Timestamp and X-ProxiaPay-Signature (hex HMAC-SHA256 over "timestamp.body" keyed on the signing secret).',
    events: ['transaction.action_required', 'transaction.succeeded', 'transaction.failed', 'transaction.expired', 'transaction.undetermined', 'transaction.corrected'],
  },
};
const out = args.out ?? 'openapi.json';
writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`wrote ${out} for ${env}`);
