import { DISPLAY_NAME_MAX } from '../alerts/mailer';
import { formatAmount } from '../money/money';
import type { PayerLanguage } from './failure-text';

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
}

const VIA = ' via ProxiaPay';

/** The sender as the payer's mail program shows it: a long project name is cut first, so " via ProxiaPay" always stays. */
export const receiptSender = (projectName: string): string =>
  `${Array.from(projectName.trim()).slice(0, DISPLAY_NAME_MAX - VIA.length).join('').trimEnd()}${VIA}`;

/**
 * The receipt mail, in the page's language and the client's name; ProxiaPay appears only as the discreet last line. Plain text
 * only: nothing from the project (name, title) is ever read as markup.
 */
export function receiptMail(data: ReceiptData, language: PayerLanguage): { subject: string; text: string } {
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
  return { subject: `${fr ? 'Votre reçu' : 'Your receipt'} - ${data.projectName}`.replace(/[\r\n]+/g, ' '), text: lines.join('\n') };
}
