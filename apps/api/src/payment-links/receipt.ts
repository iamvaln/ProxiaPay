import { DISPLAY_NAME_MAX } from '../alerts/mailer';
import { formatAmount } from '../money/money';
import type { PayerLanguage } from './failure-text';
import { DEFAULT_PRIMARY_COLOR, isHexColor } from './brand';

/** `aicha@gmail.com` as `a***@gmail.com`: the only form of the address the platform keeps. The first character whole, never half of one. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${Array.from(email)[0] ?? ''}***${email.slice(at)}`;
}

/**
 * Each country's own time zone, as the payment page has it (apps/console/src/pay/country.ts; a test keeps the two equal):
 * the mail dates the payment as the page did. A country spread over several zones has no single one.
 */
export const ZONES: Record<string, string> = {
  'Africa/Douala': 'CM', 'Africa/Libreville': 'GA', 'Africa/Brazzaville': 'CG', 'Africa/Ndjamena': 'TD', 'Africa/Bangui': 'CF',
  'Africa/Malabo': 'GQ', 'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Bamako': 'ML', 'Africa/Ouagadougou': 'BF',
  'Africa/Lome': 'TG', 'Africa/Porto-Novo': 'BJ', 'Africa/Niamey': 'NE', 'Africa/Conakry': 'GN', 'Africa/Kinshasa': 'CD',
  'Africa/Lubumbashi': 'CD',
};

function zoneOf(country: string): string | undefined {
  const zones = Object.keys(ZONES).filter((z) => ZONES[z] === country);
  return zones.length === 1 ? zones[0] : undefined;
}

const locale = (language: PayerLanguage) => (language === 'fr' ? 'fr-FR' : 'en-GB');

/** When the payment became final, in the method country's time and the mail's language; in UTC, said so, where the country has no single zone. */
export function receiptDate(at: Date, country: string, language: PayerLanguage): string {
  const zone = zoneOf(country);
  const text = new Intl.DateTimeFormat(locale(language), { dateStyle: 'long', timeStyle: 'short', timeZone: zone ?? 'UTC' }).format(at);
  return zone ? text : `${text} UTC`;
}

/**
 * An amount as the page writes it: the currency's decimals, grouping and decimal mark by language. Built from the exact
 * decimal string, so no floating point touches the figure.
 */
function money(minor: number, exponent: number, language: PayerLanguage): string {
  const [whole, fraction] = formatAmount(minor, exponent).split('.');
  const grouped = new Intl.NumberFormat(locale(language)).format(BigInt(whole!));
  if (!fraction) return grouped;
  const mark = new Intl.NumberFormat(locale(language), { minimumFractionDigits: 1 }).formatToParts(0).find((p) => p.type === 'decimal')?.value ?? '.';
  return `${grouped}${mark}${fraction}`;
}

export interface ReceiptData {
  projectName: string;
  title: string;
  reference: string;
  /** When the payment became final. */
  paidAt: Date;
  /** The payment method's country, whose time the date is shown in. */
  country: string;
  /** Amounts in minor units of the link's currency. */
  amount: number;
  fees: number;
  total: number;
  exponent: number;
  currency: string;
  method: string;
  /** The number as the platform keeps it, masked. */
  maskedNumber: string;
  /** The link's logo, absolute on the paylink host (a mail program cannot resolve a relative address); none, no image. */
  logoUrl?: string | null;
  /** The link's primary colour; anything that is not a six-digit hex never reaches the markup. */
  primaryColor?: string;
}

/** Every value from outside goes into the markup through this. */
export const escapeHtml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const VIA = ' via ProxiaPay';

/** The sender as the payer's mail program shows it: a long project name is cut first, so " via ProxiaPay" always stays. */
export const receiptSender = (projectName: string): string =>
  `${Array.from(projectName.trim()).slice(0, DISPLAY_NAME_MAX - VIA.length).join('').trimEnd()}${VIA}`;

/**
 * The receipt mail, in the page's language and the client's name; ProxiaPay appears only as the discreet last line. The text part
 * is plain: nothing from the project (name, title) is read as markup there. In the HTML part, a table layout with inline styles
 * only (mail programs drop style sheets and scripts), and every value is escaped.
 */
export function receiptMail(data: ReceiptData, language: PayerLanguage): { subject: string; text: string; html: string } {
  const fr = language === 'fr';
  const sum = (minor: number) => `${money(minor, data.exponent, language)} ${data.currency}`;
  const date = receiptDate(data.paidAt, data.country, language);
  const lines = fr
    ? [
        `Reçu de paiement - ${data.projectName}`, '',
        `Objet : ${data.title}`, `Référence : ${data.reference}`, `Date : ${date}`, '',
        `Montant : ${sum(data.amount)}`, `Frais à votre charge : ${sum(data.fees)}`, `Total payé : ${sum(data.total)}`, '',
        `Moyen de paiement : ${data.method}`, `Numéro : ${data.maskedNumber}`, '',
        'Powered by ProxiaPay',
      ]
    : [
        `Payment receipt - ${data.projectName}`, '',
        `For: ${data.title}`, `Reference: ${data.reference}`, `Date: ${date}`, '',
        `Amount: ${sum(data.amount)}`, `Fees borne by you: ${sum(data.fees)}`, `Total paid: ${sum(data.total)}`, '',
        `Method: ${data.method}`, `Number: ${data.maskedNumber}`, '',
        'Powered by ProxiaPay',
      ];
  return {
    subject: `${fr ? 'Votre reçu' : 'Your receipt'} - ${data.projectName}`.replace(/[\r\n]+/g, ' '),
    text: lines.join('\n'),
    html: receiptHtml(data, fr, date, sum),
  };
}

function receiptHtml(data: ReceiptData, fr: boolean, date: string, sum: (minor: number) => string): string {
  const e = escapeHtml;
  const primary = data.primaryColor && isHexColor(data.primaryColor) ? data.primaryColor : DEFAULT_PRIMARY_COLOR;
  const logo = data.logoUrl
    ? `<td style="padding:0 14px 0 0;vertical-align:middle;"><img src="${e(data.logoUrl)}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:10px;background:#FFFFFF;border:0;object-fit:contain;"></td>`
    : '';
  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:6px 0;color:${strong ? '#111827' : '#6B7280'};font-weight:${strong ? 700 : 400};">${e(label)}</td>`
    + `<td style="padding:6px 0;text-align:right;color:#111827;font-weight:${strong ? 700 : 500};">${e(value)}</td></tr>`;
  const rows = fr
    ? [row('Objet', data.title), row('Référence', data.reference), row('Date', date), row('Montant', sum(data.amount)), row('Frais à votre charge', sum(data.fees)), row('Total payé', sum(data.total), true), row('Moyen de paiement', data.method), row('Numéro', data.maskedNumber)]
    : [row('For', data.title), row('Reference', data.reference), row('Date', date), row('Amount', sum(data.amount)), row('Fees borne by you', sum(data.fees)), row('Total paid', sum(data.total), true), row('Method', data.method), row('Number', data.maskedNumber)];
  const title = fr ? 'Paiement réussi' : 'Payment successful';
  const heading = fr ? 'Reçu' : 'Receipt';
  return `<!doctype html>
<html lang="${fr ? 'fr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(heading)} - ${e(data.projectName)}</title></head>
<body style="margin:0;padding:0;background:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827;">
<tr><td style="background:${primary};padding:28px 32px;color:#FFFFFF;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${logo}<td style="vertical-align:middle;font-size:20px;font-weight:600;color:#FFFFFF;">${e(data.projectName)}</td></tr></table>
<h1 style="margin:22px 0 0;font-size:26px;line-height:1.2;font-weight:700;color:#FFFFFF;">${e(title)}</h1>
</td></tr>
<tr><td style="padding:28px 32px 8px;">
<h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#111827;">${e(heading)}</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:15px;line-height:1.4;">${rows.join('')}</table>
</td></tr>
<tr><td style="padding:20px 32px 28px;font-size:13px;color:#6B7280;border-top:1px solid #E5E7EB;">Powered by ProxiaPay</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
