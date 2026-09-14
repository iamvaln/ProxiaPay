/**
 * The error catalogue of API reference section 4 and functional spec 7.4. Codes are stable
 * strings a client branches on; each declares its HTTP status and whether repeating the identical
 * request could succeed later.
 */
export const REQUEST_ERRORS = {
  CREDENTIALS_INVALID: { status: 401, retryable: false },
  CREDENTIALS_REVOKED: { status: 401, retryable: false },
  TOKEN_INVALID: { status: 401, retryable: false },
  TOKEN_EXPIRED: { status: 401, retryable: true },
  SCOPE_INSUFFICIENT: { status: 403, retryable: false },
  ORIGIN_NOT_ALLOWED: { status: 403, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  FIELD_INVALID: { status: 400, retryable: false },
  AMOUNT_INVALID: { status: 400, retryable: false },
  CURRENCY_UNKNOWN: { status: 400, retryable: false },
  COUNTRY_UNKNOWN: { status: 400, retryable: false },
  PAYMENT_METHOD_UNKNOWN: { status: 400, retryable: false },
  PAYER_IDENTIFIER_INVALID: { status: 400, retryable: false },
  PAYER_IDENTIFIER_MISMATCH: { status: 400, retryable: false },
  COUNTRY_DISABLED: { status: 403, retryable: false },
  ROUTE_UNAVAILABLE: { status: 404, retryable: false },
  ROUTE_DISABLED: { status: 403, retryable: false },
  ENTITLEMENT_MISSING: { status: 403, retryable: false },
  ENTITLEMENT_DISABLED: { status: 403, retryable: false },
  AMOUNT_BELOW_MINIMUM: { status: 422, retryable: false },
  AMOUNT_ABOVE_MAXIMUM: { status: 422, retryable: false },
  VELOCITY_COUNT_EXCEEDED: { status: 422, retryable: true },
  VELOCITY_VALUE_EXCEEDED: { status: 422, retryable: true },
  PREVIEW_NOT_FOUND: { status: 404, retryable: false },
  PREVIEW_EXPIRED: { status: 409, retryable: false },
  PREVIEW_ALREADY_CONFIRMED: { status: 409, retryable: false },
  PREVIEW_DIRECTION_MISMATCH: { status: 409, retryable: false },
  REFERENCE_CONFLICT: { status: 409, retryable: false },
  SIMILAR_PAYMENT_PENDING: { status: 409, retryable: false },
  BALANCE_INSUFFICIENT: { status: 422, retryable: false },
  FLOAT_INSUFFICIENT: { status: 503, retryable: true },
  CODE_INVALID: { status: 422, retryable: true },
  CODE_ATTEMPTS_EXHAUSTED: { status: 409, retryable: false },
  TRANSACTION_NOT_FOUND: { status: 404, retryable: false },
  ACTION_NOT_AVAILABLE: { status: 409, retryable: false },
  NO_PROVIDER_AVAILABLE: { status: 503, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: true },
  // Console-side codes share the shape.
  UNAUTHENTICATED: { status: 401, retryable: false },
  SECOND_FACTOR_REQUIRED: { status: 401, retryable: false },
  ACCOUNT_LOCKED: { status: 423, retryable: true },
  PERMISSION_DENIED: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  CONFLICT: { status: 409, retryable: false },
  CONFIRMATION_REQUIRED: { status: 428, retryable: false },
  CONFIRMATION_INVALID: { status: 422, retryable: true },
  APPROVAL_REQUIRED: { status: 202, retryable: false },
  RULE_VIOLATION: { status: 422, retryable: false },
} as const;

export type ErrorCode = keyof typeof REQUEST_ERRORS;

/** Failure reasons describe a transaction that was created and ended (spec 7.4). */
export const FAILURE_REASONS = [
  'PAYER_DECLINED', 'PAYER_UNRESPONSIVE', 'WALLET_NOT_FOUND', 'WALLET_INACTIVE', 'WALLET_LIMIT_EXCEEDED',
  'WALLET_BALANCE_INSUFFICIENT', 'CODE_ATTEMPTS_EXHAUSTED', 'ACTION_WINDOW_EXPIRED', 'PROVIDER_REJECTED',
  'PROVIDER_UNAVAILABLE', 'NO_PROVIDER_AVAILABLE', 'OUTCOME_UNDETERMINED',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface ErrorBody {
  error: { code: ErrorCode; message: string; field?: string; retryable: boolean; details?: Record<string, unknown> };
}

export class PlatformError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: { field?: string; details?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'PlatformError';
    const def = REQUEST_ERRORS[code];
    this.status = def.status;
    this.retryable = def.retryable;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { error: { code: this.code, message: this.message, retryable: this.retryable } };
    if (this.options.field) body.error.field = this.options.field;
    if (this.options.details) body.error.details = this.options.details;
    return body;
  }
}

export const fieldInvalid = (field: string, message: string): PlatformError => new PlatformError('FIELD_INVALID', message, { field });
