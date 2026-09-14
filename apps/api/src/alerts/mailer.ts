import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/config';
import { log } from '../logging/logger';
import { fetchJson } from '../providers/adapter';

export interface Mail { to: string; subject: string; text: string; sensitive?: boolean }

/** Resend's single sending endpoint. The region a domain sends from is a property of the domain in Resend, not of the URL. */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;

/**
 * Email delivery for alerts and one-time codes, through Resend. Without an API key, messages are
 * logged (with sensitive bodies replaced) so development and tests run without a mail service;
 * the `sent` list lets tests read what would have gone out. A refusal or an unreachable service
 * throws, so the caller records the delivery as failed with the reason rather than as sent.
 */
@Injectable()
export class Mailer {
  private readonly logger = log('mailer');
  readonly sent: Mail[] = [];
  constructor(@Inject(CONFIG) private readonly config: Pick<AppConfig, 'RESEND_API_KEY' | 'MAIL_FROM' | 'NODE_ENV'>) {}

  async send(mail: Mail): Promise<'sent' | 'logged'> {
    if (this.config.NODE_ENV === 'test') this.sent.push(mail);
    if (!this.config.RESEND_API_KEY) {
      // Outside production the full text is logged so one-time codes can be read during development; in production a sensitive body is never logged.
      const body = mail.sensitive && this.config.NODE_ENV === 'production' ? '[sensitive]' : mail.text;
      this.logger.info({ to: mail.to, subject: mail.subject, mail_body: body }, 'mail logged (no RESEND_API_KEY configured)');
      return 'logged';
    }
    const res = await fetchJson(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.config.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text }),
      timeoutMs: RESEND_TIMEOUT_MS,
    });
    if (res.timedOut) throw new Error('resend: request timed out');
    if (res.status < 200 || res.status >= 300) {
      const detail = res.body && typeof res.body === 'object' ? (res.body as { message?: string; name?: string }) : {};
      throw new Error(`resend: ${res.status} ${detail.name ?? ''} ${detail.message ?? ''}`.trim());
    }
    const id = (res.body as { id?: string } | null)?.id;
    this.logger.info({ to: mail.to, subject: mail.subject, resend_id: id }, 'mail sent');
    return 'sent';
  }
}
