/** The payment page's words, in English and French (spec: the page, language). Content the client entered is never translated. */
export type Lang = 'en' | 'fr';

const STRINGS = {
  'page.loading': { en: 'Loading…', fr: 'Chargement…' },
  'page.sandbox': { en: 'Sandbox — no real money moves', fr: 'Sandbox — aucun argent réel ne circule' },
  'page.secure': { en: 'Secure payment · Powered by ProxiaPay', fr: 'Paiement sécurisé · Powered by ProxiaPay' },
  'page.powered': { en: 'Powered by', fr: 'Powered by' },
  'page.language': { en: 'Language', fr: 'Langue' },
  'page.unavailable': { en: 'This link is no longer available', fr: 'Ce lien n’est plus disponible' },
  'page.unavailable_hint': { en: 'Ask whoever sent it to you for a new one.', fr: 'Demandez-en un nouveau à la personne qui vous l’a envoyé.' },
  'page.load_failed': { en: 'We could not load this page. Check your connection and try again.', fr: 'Impossible de charger cette page. Vérifiez votre connexion et réessayez.' },
  'page.retry': { en: 'Try again', fr: 'Réessayer' },
  'page.no_methods': { en: 'No payment method is available right now. Please try again later.', fr: 'Aucun moyen de paiement n’est disponible pour le moment. Réessayez plus tard.' },
  'page.amount_free': { en: 'Amount of your choice', fr: 'Montant libre' },

  'form.title': { en: 'Your payment', fr: 'Votre paiement' },
  'form.amount': { en: 'Amount ({currency})', fr: 'Montant ({currency})' },
  'form.minimum': { en: 'Minimum {amount}', fr: 'Minimum {amount}' },
  'form.amount_invalid': { en: 'Enter a valid amount.', fr: 'Saisissez un montant valide.' },
  'form.amount_min': { en: 'The amount must be at least {amount}.', fr: 'Le montant doit être d’au moins {amount}.' },
  'form.amount_max': { en: 'The amount must be at most {amount}.', fr: 'Le montant ne peut pas dépasser {amount}.' },
  'form.quote': { en: 'Fees {fees} · total to pay {total}', fr: 'Frais {fees} · total à payer {total}' },
  'form.total': { en: 'Total to pay with {operator}: {total}', fr: 'Total à payer avec {operator} : {total}' },
  'form.country': { en: 'Country', fr: 'Pays' },
  'form.method': { en: 'Payment method', fr: 'Moyen de paiement' },
  'form.number': { en: '{operator} number', fr: 'Numéro {operator}' },
  'form.continue': { en: 'Continue', fr: 'Continuer' },
  'form.wait': { en: 'Please wait…', fr: 'Patientez…' },

  'review.title': { en: 'Check before you pay', fr: 'Vérifiez avant de payer' },
  'review.amount': { en: 'Amount', fr: 'Montant' },
  'review.fees': { en: '{operator} fees', fr: 'Frais {operator}' },
  'review.method': { en: 'Method', fr: 'Moyen' },
  'review.number': { en: 'Number', fr: 'Numéro' },
  'review.total': { en: 'Total to pay', fr: 'Total à payer' },
  'review.holds': { en: 'This total holds for {duration}. Once you confirm, {operator} will send you a payment request.', fr: 'Ce total est garanti pendant {duration}. Après confirmation, {operator} vous enverra une demande de paiement.' },
  'review.minute': { en: '1 minute', fr: '1 minute' },
  'review.minutes': { en: '{n} minutes', fr: '{n} minutes' },
  'review.edit': { en: 'Edit', fr: 'Modifier' },
  'review.confirm': { en: 'Confirm and pay {total}', fr: 'Confirmer et payer {total}' },

  'sent.title': { en: 'Approve the payment on your phone', fr: 'Validez le paiement sur votre téléphone' },
  'sent.body': { en: 'A payment request was sent to {number}. Approve it on your phone or in your {operator} app.', fr: 'Une demande de paiement a été envoyée au {number}. Validez-la sur votre téléphone ou dans votre application {operator}.' },
  'sent.body_phone': { en: 'A payment request was sent to your phone. Approve it on your phone or in your {operator} app.', fr: 'Une demande de paiement a été envoyée sur votre téléphone. Validez-la sur votre téléphone ou dans votre application {operator}.' },
  'sent.total': { en: 'Total to pay: {total}', fr: 'Total à payer : {total}' },
  'sent.waiting': { en: 'Waiting for your approval…', fr: 'En attente de votre validation…' },
  'sent.nothing': { en: 'Nothing to type here: this page updates on its own once the operator confirms.', fr: 'Vous n’avez rien à saisir ici : cette page se met à jour dès que l’opérateur confirme.' },

  'checking.title': { en: 'Payment being checked', fr: 'Paiement en cours de vérification' },
  'checking.body': { en: 'We are checking with the operator; you can close this page.', fr: 'Nous vérifions auprès de l’opérateur ; vous pouvez fermer cette page.' },

  'failed.title': { en: 'The payment did not go through', fr: 'Le paiement n’a pas abouti' },
  'failed.generic': { en: 'The operator did not confirm the payment.', fr: 'L’opérateur n’a pas confirmé le paiement.' },
  'failed.retry': { en: 'Try again', fr: 'Réessayer' },
  'failed.closed': { en: 'This link no longer takes payments.', fr: 'Ce lien n’accepte plus de paiement.' },

  'success.title': { en: 'Payment successful', fr: 'Paiement réussi' },
  'success.thanks': { en: 'Thank you. Your payment to {project} went through.', fr: 'Merci. Votre paiement à {project} a bien été effectué.' },

  'receipt.title': { en: 'Receipt', fr: 'Reçu' },
  'receipt.paid_to': { en: 'Paid to', fr: 'Bénéficiaire' },
  'receipt.for': { en: 'For', fr: 'Objet' },
  'receipt.amount': { en: 'Amount', fr: 'Montant' },
  'receipt.fees': { en: 'Fees', fr: 'Frais' },
  'receipt.total': { en: 'Total paid', fr: 'Total payé' },
  'receipt.method': { en: 'Method', fr: 'Moyen' },
  'receipt.reference': { en: 'Reference', fr: 'Référence' },
  'receipt.email': { en: 'Get the receipt by email', fr: 'Recevoir le reçu par email' },
  'receipt.optional': { en: '(optional)', fr: '(facultatif)' },
  'receipt.placeholder': { en: 'you@example.com', fr: 'vous@exemple.com' },
  'receipt.send': { en: 'Send me the receipt', fr: 'M’envoyer le reçu' },
  'receipt.sending': { en: 'Sending…', fr: 'Envoi…' },
  'receipt.sent': { en: 'The receipt is on its way. Check your inbox.', fr: 'Le reçu est en route. Consultez votre boîte de réception.' },
  'receipt.failed': { en: 'We could not send the email; save the receipt instead.', fr: 'Nous n’avons pas pu envoyer l’email ; enregistrez plutôt le reçu.' },
  'receipt.print': { en: 'Save or print the receipt', fr: 'Enregistrer ou imprimer le reçu' },

  'error.rate_limited': { en: 'Too many attempts, please wait a moment.', fr: 'Trop de tentatives, patientez un instant.' },
  'error.network': { en: 'We could not reach the server. Check your connection and try again.', fr: 'Impossible de joindre le serveur. Vérifiez votre connexion et réessayez.' },
  'error.generic': { en: 'Something went wrong. Please try again.', fr: 'Une erreur est survenue. Réessayez.' },
  'error.payment_gone': { en: 'This payment is no longer available.', fr: 'Ce paiement n’est plus disponible.' },
  'error.total_expired': { en: 'This total has expired; start again.', fr: 'Ce total a expiré ; recommencez.' },
  'error.in_progress': { en: 'A payment is already in progress on this link.', fr: 'Un paiement est déjà en cours sur ce lien.' },
  'error.being_checked': { en: 'A payment on this link is being checked.', fr: 'Un paiement sur ce lien est en cours de vérification.' },
  'error.number_pending': { en: 'A payment from this number is already in progress.', fr: 'Un paiement depuis ce numéro est déjà en cours.' },
  'error.method_down': { en: 'This payment method is not available right now. Try again later.', fr: 'Ce moyen de paiement n’est pas disponible pour le moment. Réessayez plus tard.' },
  'error.link_busy': { en: 'This link cannot take more payments right now. Try again later.', fr: 'Ce lien ne peut pas recevoir plus de paiements pour le moment. Réessayez plus tard.' },
} satisfies Record<string, Record<Lang, string>>;

export type Key = keyof typeof STRINGS;
export const KEYS = Object.keys(STRINGS) as Key[];

export function t(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  return STRINGS[key][lang].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** French for a browser that asks for French first among the two, English otherwise. */
export function detectLanguage(langs: readonly string[] = navigator.languages ?? []): Lang {
  for (const tag of langs) {
    const base = tag.toLowerCase().slice(0, 2);
    if (base === 'fr') return 'fr';
    if (base === 'en') return 'en';
  }
  return 'en';
}

/** Money as the payer reads it, in the link's currency and exponent; grouping and decimal mark follow the language. */
export function money(minor: number, currency: string, exponent: number, lang: Lang): string {
  const figure = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(minor / 10 ** exponent);
  return `${figure} ${currency}`;
}

/** A typed amount in minor units, or null when it is not a plain positive figure with at most the currency's decimals. */
export function parseAmount(text: string, exponent: number): number | null {
  const s = text.replace(/[\s  ]/g, '').replace(',', '.');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > exponent) return null;
  const minor = Number(m[1]) * 10 ** exponent + Number(fraction.padEnd(exponent, '0') || '0');
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** A country's name in the page's language, falling back to the name the API gives. */
export function countryName(code: string, fallback: string, lang: Lang): string {
  try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? fallback; } catch { return fallback; }
}
