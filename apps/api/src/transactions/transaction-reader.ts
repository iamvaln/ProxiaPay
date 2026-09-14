import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { CryptoService } from '../crypto/crypto.service';
import { DB_TOKEN, type Db, type Executor } from '../db/database';
import type { DB } from '../db/schema.generated';
import { sum } from '../money/money';

export type TransactionRow = Selectable<DB['transaction']>;
export type AttemptRow = Selectable<DB['transaction_attempt']>;
export type PreviewRow = Selectable<DB['preview']>;

export interface ApiTransaction {
  reference: string;
  project_reference: string;
  provider_reference: string | null;
  operator_reference: string | null;
  direction: string;
  state: string;
  reconciliation_status: string;
  currency: string;
  requested_amount: number;
  charged_amount: number;
  settled_amount: number | null;
  fees: { processing: { amount: number; bearer: string }; platform: { amount: number; bearer: string }; total: number };
  route: { country: string; payment_method: string; direction: string };
  counterparty: { msisdn: string; name?: string; email?: string };
  action: { type: string; url?: string; attempts_remaining?: number; expires_at: string | null } | null;
  failure_reason: string | null;
  metadata: unknown;
  created_at: string;
  terminal_at: string | null;
}

/** Builds the transaction object of API reference 5.7 from its rows. */
@Injectable()
export class TransactionReader {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly crypto: CryptoService) {}

  async load(exec: Executor, transactionId: string): Promise<{ txn: TransactionRow; attempt: AttemptRow | undefined; route: { country_code: string; payment_method_code: string; direction: string } }> {
    const txn = await exec.selectFrom('transaction').selectAll().where('id', '=', transactionId).executeTakeFirstOrThrow();
    const attempt = txn.current_attempt_id ? await exec.selectFrom('transaction_attempt').selectAll().where('id', '=', txn.current_attempt_id).executeTakeFirst() : undefined;
    const route = await exec.selectFrom('route').select(['country_code', 'payment_method_code', 'direction']).where('id', '=', txn.route_id).executeTakeFirstOrThrow();
    return { txn, attempt, route };
  }

  /** The project-facing shape. `revealAction` controls whether a browser address is included (never in the console). */
  toApi(txn: TransactionRow, attempt: AttemptRow | undefined, route: { country_code: string; payment_method_code: string; direction: string }, opts: { revealMsisdn: boolean; revealAction: boolean }): ApiTransaction {
    const msisdn = opts.revealMsisdn ? this.crypto.openString(txn.msisdn_ciphertext, 'msisdn') : txn.msisdn_masked;
    let action: ApiTransaction['action'] = null;
    if (txn.state === 'action_required') {
      action = { type: txn.payer_action, expires_at: txn.action_expires_at?.toISOString() ?? null };
      if (txn.payer_action === 'code') action.attempts_remaining = txn.code_attempts_remaining ?? 0;
      if (txn.payer_action === 'browser' && opts.revealAction && txn.action_url_ciphertext) action.url = this.crypto.openString(txn.action_url_ciphertext, `action_url:${txn.id}`);
    }
    return {
      reference: txn.reference,
      project_reference: txn.project_reference,
      provider_reference: attempt?.provider_reference ?? null,
      operator_reference: attempt?.operator_reference ?? null,
      direction: txn.direction,
      state: txn.state,
      reconciliation_status: txn.reconciliation_status,
      currency: txn.currency_code,
      requested_amount: txn.requested_amount,
      charged_amount: txn.charged_amount,
      settled_amount: txn.settled_amount,
      fees: {
        processing: { amount: txn.processing_fee, bearer: txn.processing_fee_bearer },
        platform: { amount: txn.platform_fee, bearer: txn.platform_fee_bearer },
        total: sum(txn.processing_fee, txn.platform_fee),
      },
      route: { country: route.country_code, payment_method: route.payment_method_code, direction: route.direction },
      counterparty: { msisdn, ...(txn.counterparty_name ? { name: txn.counterparty_name } : {}), ...(txn.counterparty_email ? { email: txn.counterparty_email } : {}) },
      action,
      failure_reason: txn.failure_reason,
      metadata: txn.metadata,
      created_at: txn.created_at.toISOString(),
      terminal_at: txn.terminal_at?.toISOString() ?? null,
    };
  }

  async apiById(exec: Executor, transactionId: string, opts: { revealMsisdn: boolean; revealAction: boolean }): Promise<ApiTransaction> {
    const { txn, attempt, route } = await this.load(exec, transactionId);
    return this.toApi(txn, attempt, route, opts);
  }

  previewToApi(p: PreviewRow, route: { country_code: string; payment_method_code: string; direction: string }, reveal: boolean) {
    return {
      reference: p.reference,
      direction: p.direction,
      currency: p.currency_code,
      requested_amount: p.requested_amount,
      charged_amount: p.charged_amount,
      settled_amount: p.settled_amount,
      fees: {
        processing: { amount: p.processing_fee, bearer: p.processing_fee_bearer },
        platform: { amount: p.platform_fee, bearer: p.platform_fee_bearer },
        total: sum(p.processing_fee, p.platform_fee),
      },
      route: { country: route.country_code, payment_method: route.payment_method_code, direction: route.direction },
      counterparty: { msisdn: reveal ? this.crypto.openString(p.msisdn_ciphertext, 'msisdn') : p.msisdn_masked, ...(p.counterparty_name ? { name: p.counterparty_name } : {}) },
      payer_action: p.payer_action,
      project_reference: p.project_reference,
      metadata: p.metadata,
      status: p.status,
      expires_at: p.expires_at.toISOString(),
      created_at: p.created_at.toISOString(),
    };
  }
}
