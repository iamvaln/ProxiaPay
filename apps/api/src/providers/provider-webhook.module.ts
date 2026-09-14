import { Controller, HttpCode, Inject, Module, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { newCorrelationId } from '../crypto/references';
import { DB_TOKEN, type Db } from '../db/database';
import { log } from '../logging/logger';
import { ProviderAccountService } from './provider-account.service';
import { StatusService } from './status.service';
import { CryptoService } from '../crypto/crypto.service';

/**
 * Inbound provider notifications (spec 5.6). Whatever a notification asserts, the platform
 * answers 200 and verifies by status check; a forged or replayed one moves nothing. Where an
 * account holds a webhook secret, the signature is checked before the notification is taken as a trigger.
 */
@Controller('providers')
export class ProviderWebhookController {
  private readonly logger = log('webhooks');
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly accounts: ProviderAccountService, private readonly status: StatusService, private readonly crypto: CryptoService) {}

  @Post(':accountId/notifications')
  @HttpCode(200)
  async receive(@Param('accountId') accountId: string, @Req() req: Request & { rawBody?: Buffer }) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const account = await this.db.selectFrom('provider_account').select(['id', 'webhook_secret_ciphertext']).where('id', '=', accountId).executeTakeFirst();
    if (!account) return { received: false };
    if (account.webhook_secret_ciphertext) {
      const secret = this.crypto.openString(account.webhook_secret_ciphertext, `webhook:${account.id}`);
      const provided = String(req.headers['x-signature'] ?? req.headers['x-webhook-signature'] ?? '');
      if (!CryptoService.constantTimeEqual(CryptoService.hmacSha256Hex(secret, raw), provided)) {
        this.logger.warn({ account: account.id }, 'notification signature mismatch; ignored');
        return { received: true };
      }
    }
    const { ctx, adapterKey } = await this.accounts.context(this.db, account.id, newCorrelationId());
    const payloadId = await ctx.recordPayload('inbound_notification', 'webhook', safeJson(raw));
    const event = await this.accounts.adapter(adapterKey).parseNotification(ctx, req.headers, raw);
    if (!event) return { received: true };
    const outcome = await this.status.onProviderNotification(account.id, event.providerReference, event.eventKey, event.externalReference, payloadId);
    this.logger.info({ account: account.id, outcome, event: event.eventKey }, 'provider notification');
    return { received: true };
  }
}

function safeJson(raw: Buffer): unknown {
  try { return JSON.parse(raw.toString('utf8')); } catch { return { raw: raw.toString('utf8').slice(0, 4000) }; }
}

@Module({ controllers: [ProviderWebhookController] })
export class ProviderWebhookModule {}
