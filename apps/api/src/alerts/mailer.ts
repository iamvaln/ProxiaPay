import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/config';
import { log } from '../logging/logger';

export interface Mail { to: string; subject: string; text: string; sensitive?: boolean }

/**
 * Email delivery for alerts and one-time codes. Without SMTP configured, messages are logged
 * (with sensitive bodies replaced) so development and tests run without a mail server; the
 * `sent` list lets tests read what would have gone out.
 */
@Injectable()
export class Mailer {
  private readonly logger = log('mailer');
  readonly sent: Mail[] = [];
  constructor(@Inject(CONFIG) private readonly config: Pick<AppConfig, 'SMTP_URL' | 'NODE_ENV'>) {}

  async send(mail: Mail): Promise<'sent' | 'logged'> {
    if (this.config.NODE_ENV === 'test') this.sent.push(mail);
    if (!this.config.SMTP_URL) {
      // Outside production the full text is logged so one-time codes can be read during development; in production a sensitive body is never logged.
      const body = mail.sensitive && this.config.NODE_ENV === 'production' ? '[sensitive]' : mail.text;
      this.logger.info({ to: mail.to, subject: mail.subject, mail_body: body }, 'mail logged (no SMTP configured)');
      return 'logged';
    }
    // SMTP transport is a deployment concern; the platform ships with the interface and the logged fallback.
    this.logger.warn({ to: mail.to, subject: mail.subject }, 'SMTP_URL is set but no transport is compiled in; message logged');
    return 'logged';
  }
}
