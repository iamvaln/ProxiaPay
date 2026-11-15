import type { FailureReason } from '../common/errors';

export type PayerLanguage = 'en' | 'fr';

/** The page's language from `?lang=`: French when asked for, English otherwise. */
export const payerLanguage = (lang: unknown): PayerLanguage => (lang === 'fr' ? 'fr' : 'en');

/**
 * Why a payment did not go through, as the payer reads it on the page: a plain sentence for each failure reason, never the
 * reason's code or what the provider said. Typed over every reason, so a new one cannot reach the page without its words.
 */
const FAILURE_TEXT: Record<FailureReason, Record<PayerLanguage, string>> = {
  PAYER_DECLINED: { en: 'The payment was declined on the phone.', fr: 'Le paiement a été refusé sur le téléphone.' },
  PAYER_UNRESPONSIVE: { en: 'The payment request was not approved in time.', fr: "La demande de paiement n'a pas été validée à temps." },
  WALLET_NOT_FOUND: { en: 'No mobile money account was found for this number.', fr: "Aucun compte mobile money n'a été trouvé pour ce numéro." },
  WALLET_INACTIVE: { en: 'The mobile money account for this number is not active.', fr: "Le compte mobile money de ce numéro n'est pas actif." },
  WALLET_LIMIT_EXCEEDED: { en: 'This payment goes over the limits of the mobile money account.', fr: 'Ce paiement dépasse les plafonds du compte mobile money.' },
  WALLET_BALANCE_INSUFFICIENT: { en: 'The balance on the account was not enough for this payment.', fr: 'Le solde du compte ne suffisait pas pour ce paiement.' },
  CODE_ATTEMPTS_EXHAUSTED: { en: 'Too many wrong codes were entered.', fr: 'Trop de codes erronés ont été saisis.' },
  ACTION_WINDOW_EXPIRED: { en: 'The payment request expired before it was approved.', fr: "La demande de paiement a expiré avant d'être validée." },
  PROVIDER_REJECTED: { en: 'The operator did not accept this payment.', fr: "L'opérateur n'a pas accepté ce paiement." },
  PROVIDER_UNAVAILABLE: { en: 'The operator could not be reached.', fr: "L'opérateur n'a pas pu être joint." },
  NO_PROVIDER_AVAILABLE: { en: 'This payment method is not available right now.', fr: "Ce moyen de paiement n'est pas disponible pour le moment." },
  OUTCOME_UNDETERMINED: { en: 'The payment could not be confirmed.', fr: "Le paiement n'a pas pu être confirmé." },
};
const FALLBACK: Record<PayerLanguage, string> = { en: 'The payment did not go through.', fr: "Le paiement n'a pas abouti." };

export function failureText(reason: string | null, lang: PayerLanguage): string {
  return (reason !== null && Object.hasOwn(FAILURE_TEXT, reason) ? FAILURE_TEXT[reason as FailureReason] : FALLBACK)[lang];
}
