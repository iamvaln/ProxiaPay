import type { PayerLanguage } from './failure-text';

/** `aicha@gmail.com` as `a***@gmail.com`: the only form of the address the platform keeps. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export interface ReceiptData {
  projectName: string;
  title: string;
  reference: string;
  /** When the payment became final, shown in UTC. */
  paidAt: Date;
  /** Amounts already written for reading, in the link's currency. */
  amount: string;
  fees: string;
  total: string;
  currency: string;
  method: string;
  /** The number as the platform keeps it, masked. */
  maskedNumber: string;
}

/** The sender as the payer's mail program shows it. */
export const receiptSender = (projectName: string): string => `${projectName} via ProxiaPay`;

const utc = (d: Date) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;

/**
 * The receipt mail, in the page's language and the client's name; ProxiaPay appears only as the discreet last line. Plain text
 * only: nothing from the project (name, title) is ever read as markup.
 */
export function receiptMail(data: ReceiptData, language: PayerLanguage): { subject: string; text: string } {
  const fr = language === 'fr';
  const lines = fr
    ? [
        `Reçu de paiement - ${data.projectName}`, '',
        `Objet : ${data.title}`, `Référence : ${data.reference}`, `Date : ${utc(data.paidAt)}`, '',
        `Montant : ${data.amount} ${data.currency}`, `Frais à votre charge : ${data.fees} ${data.currency}`, `Total payé : ${data.total} ${data.currency}`, '',
        `Moyen de paiement : ${data.method}`, `Numéro : ${data.maskedNumber}`, '',
        'Powered by ProxiaPay',
      ]
    : [
        `Payment receipt - ${data.projectName}`, '',
        `For: ${data.title}`, `Reference: ${data.reference}`, `Date: ${utc(data.paidAt)}`, '',
        `Amount: ${data.amount} ${data.currency}`, `Fees borne by you: ${data.fees} ${data.currency}`, `Total paid: ${data.total} ${data.currency}`, '',
        `Method: ${data.method}`, `Number: ${data.maskedNumber}`, '',
        'Powered by ProxiaPay',
      ];
  return { subject: `${fr ? 'Votre reçu' : 'Your receipt'} - ${data.projectName}`.replace(/[\r\n]+/g, ' '), text: lines.join('\n') };
}
