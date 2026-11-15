import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PlatformError } from '../common/errors';
import { CONFIG, type AppConfig } from '../config/config';
import { clientAddress } from '../http/client-address';
import { enforceLimit, LinkPaymentsService } from '../payment-links/link-payments.service';
import { PublicLinkService } from '../payment-links/public-view';
import { RateLimiter } from '../project-auth/rate-limiter';

/** The only types a logo is served as, whatever the store holds: never anything a browser would run. */
const SERVABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * The payment page's API (spec: payment links, paying). Public: no session, no credential, no guard. It answers
 * only what the page shows, and is mounted outside the console module so nothing of the console's reaches it.
 */
@Controller('pay-api/v1')
export class PayApiController {
  constructor(
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'TRUSTED_PROXY_HOPS'>,
    private readonly links: PublicLinkService,
    private readonly payments: LinkPaymentsService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Fixed windows in the store, as for project credentials; a limited caller is told plainly when to come back. */
  private limit(key: string, limit: number, windowSeconds: number): Promise<void> {
    return enforceLimit(this.limiter, key, limit, windowSeconds);
  }

  /** Generous: many payers can share one address behind a mobile carrier. */
  @Get('links/:code')
  async link(@Param('code') code: string, @Req() req: Request) {
    await this.limit(`paylink:read:${clientAddress(req, this.config.TRUSTED_PROXY_HOPS)}`, 300, 60);
    return this.links.view(code);
  }

  /** Called as the payer types an amount, so it creates nothing; 60 a minute per address. */
  @Post('links/:code/quote')
  @HttpCode(200)
  async quote(@Param('code') code: string, @Body() body: unknown, @Req() req: Request) {
    await this.limit(`paylink:quote:${clientAddress(req, this.config.TRUSTED_PROXY_HOPS)}`, 60, 60);
    return this.links.quote(code, body);
  }

  /** The review step: a real preview, priced and frozen, and the token the page follows the payment by. Nothing is asked of the payer yet. */
  @Post('links/:code/previews')
  @HttpCode(201)
  async preview(@Param('code') code: string, @Body() body: unknown, @Req() req: Request) {
    const { token, review } = await this.payments.preview(code, body, clientAddress(req, this.config.TRUSTED_PROXY_HOPS));
    return { payment_token: token, review };
  }

  /** The payer confirms the total: only now does the operator send them a request. */
  @Post('payments/:token/confirm')
  @HttpCode(200)
  async confirm(@Param('token') token: string, @Req() req: Request) {
    return this.payments.confirm(token, clientAddress(req, this.config.TRUSTED_PROXY_HOPS));
  }

  /**
   * The page follows the payment here until its outcome is in, in the page's language (`?lang=fr|en`): 60 a minute per token,
   * charged once the token is found, and, as for reading a link, a generous ceiling per address, charged first: that ceiling
   * is what bounds guessing at tokens, and a guess leaves nothing in the store.
   */
  @Get('payments/:token')
  async payment(@Param('token') token: string, @Query('lang') lang: unknown, @Req() req: Request) {
    await this.limit(`paylink:payment-read:${clientAddress(req, this.config.TRUSTED_PROXY_HOPS)}`, 300, 60);
    return this.payments.follow(token, lang);
  }

  /** The receipt by email, for a succeeded payment: the address is used for the send and not kept. */
  @Post('payments/:token/receipt')
  @HttpCode(200)
  async receipt(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    await this.limit(`paylink:receipt-address:${clientAddress(req, this.config.TRUSTED_PROXY_HOPS)}`, 60, 60);
    return this.payments.sendReceipt(token, body);
  }

  /**
   * A logo, by id: immutable (a new logo is a new asset), so it is cached for good. Defence in depth past the upload's
   * magic-byte check and the table's constraint: an image type only, never sniffed, and inert if opened on its own.
   */
  @Get('assets/:id')
  async asset(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    await this.limit(`paylink:asset:${clientAddress(req, this.config.TRUSTED_PROXY_HOPS)}`, 300, 60);
    const { bytes, content_type } = await this.links.asset(id);
    if (!SERVABLE.has(content_type)) throw new PlatformError('NOT_FOUND', 'No such resource.');
    res.setHeader('Content-Type', content_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline; filename="logo"');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).end(bytes);
  }
}
