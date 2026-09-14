export type Lang = 'en' | 'fr';

/** Interface text in both languages (console spec 3.3). Content people entered is never translated. */
const STRINGS: Record<string, { en: string; fr: string }> = {
  'nav.home': { en: 'Home', fr: 'Accueil' }, 'nav.transactions': { en: 'Transactions', fr: 'Transactions' }, 'nav.projects': { en: 'Projects', fr: 'Projets' },
  'nav.configuration': { en: 'Configuration', fr: 'Configuration' }, 'nav.treasury': { en: 'Treasury', fr: 'Trésorerie' }, 'nav.reconciliation': { en: 'Reconciliation', fr: 'Rapprochement' },
  'nav.oversight': { en: 'Oversight', fr: 'Supervision' }, 'nav.sign_out': { en: 'Sign out', fr: 'Déconnexion' },
  'env.production': { en: 'PRODUCTION', fr: 'PRODUCTION' }, 'env.sandbox': { en: 'SANDBOX', fr: 'BAC À SABLE' },
  'search.placeholder': { en: 'Search any reference or telephone number', fr: 'Rechercher une référence ou un numéro' },
  'signin.title': { en: 'Sign in', fr: 'Connexion' }, 'signin.email': { en: 'Email address', fr: 'Adresse e-mail' }, 'signin.password': { en: 'Password', fr: 'Mot de passe' },
  'signin.submit': { en: 'Continue', fr: 'Continuer' }, 'signin.mismatch': { en: 'The address and password did not match.', fr: "L'adresse et le mot de passe ne correspondent pas." },
  'signin.locked': { en: 'The account is locked until {until}. Waiting will help.', fr: 'Le compte est verrouillé jusqu’à {until}. Attendre suffira.' },
  'signin.reset': { en: 'Request a password reset', fr: 'Demander une réinitialisation' },
  'signin.reset_sent': { en: 'If that address belongs to an administrator, a link is on its way.', fr: 'Si cette adresse appartient à un administrateur, un lien est en route.' },
  'second.title': { en: 'Second factor', fr: 'Second facteur' }, 'second.code': { en: 'Code from your authenticator', fr: 'Code de votre application' },
  'second.enrol': { en: 'Scan this QR code with an authenticator application, then enter the code it shows.', fr: 'Scannez ce QR code avec une application d’authentification, puis saisissez le code affiché.' },
  'second.enrol_manual': { en: 'Cannot scan? Enter this key manually:', fr: 'Impossible de scanner ? Saisissez cette clé manuellement :' },
  'second.enrol_qr_alt': { en: 'QR code of the authenticator secret', fr: 'QR code du secret d’authentification' },
  'second.verify': { en: 'Verify', fr: 'Vérifier' },
  'home.approvals': { en: 'Awaiting your approval', fr: 'En attente de votre approbation' }, 'home.alerts': { en: 'Open alerts', fr: 'Alertes ouvertes' }, 'home.float': { en: 'Float cover', fr: 'Couverture de trésorerie' },
  'home.coverage': { en: 'Coverage ratio', fr: 'Ratio de couverture' }, 'home.discrepancies': { en: 'Open discrepancies', fr: 'Écarts ouverts' }, 'home.activity': { en: "Today's activity", fr: 'Activité du jour' },
  'home.earnings': { en: 'Earnings and cost recovery', fr: 'Revenus et recouvrement des coûts' }, 'home.providers': { en: 'Provider status', fr: 'État des fournisseurs' },
  'home.platform_revenue': { en: 'Platform revenue', fr: 'Revenu plateforme' }, 'home.margin': { en: 'Margin', fr: 'Marge' },
  'common.scoped': { en: 'Limited to your scope', fr: 'Limité à votre périmètre' }, 'common.none': { en: 'Nothing to show yet.', fr: 'Rien à afficher pour l’instant.' },
  'common.loading': { en: 'Loading…', fr: 'Chargement…' }, 'common.save': { en: 'Save', fr: 'Enregistrer' }, 'common.cancel': { en: 'Cancel', fr: 'Annuler' }, 'common.confirm': { en: 'Confirm', fr: 'Confirmer' },
  'common.code_prompt': { en: 'A code was sent to you. Enter it to commit this operation.', fr: 'Un code vous a été envoyé. Saisissez-le pour valider cette opération.' },
  'common.permission_needed': { en: 'Requires permission {permission}', fr: 'Nécessite la permission {permission}' },
  'common.approve': { en: 'Approve', fr: 'Approuver' }, 'common.decline': { en: 'Decline', fr: 'Refuser' }, 'common.own_request': { en: 'Your own request', fr: 'Votre propre demande' },
  'txn.state': { en: 'State', fr: 'État' }, 'txn.reference': { en: 'Reference', fr: 'Référence' }, 'txn.project': { en: 'Project', fr: 'Projet' }, 'txn.route': { en: 'Route', fr: 'Route' },
  'txn.amount': { en: 'Requested', fr: 'Demandé' }, 'txn.created': { en: 'Created', fr: 'Créé' }, 'txn.terminal': { en: 'Terminal', fr: 'Terminé' }, 'txn.recon': { en: 'Reconciliation', fr: 'Rapprochement' },
  'txn.export': { en: 'Export CSV', fr: 'Exporter CSV' }, 'txn.previews': { en: 'Previews', fr: 'Aperçus' }, 'txn.reveal': { en: 'Reveal identifier', fr: 'Révéler l’identifiant' },
  'txn.recheck': { en: 'Force status re-check', fr: 'Forcer une vérification' }, 'txn.replay': { en: 'Replay', fr: 'Renvoyer' },
};

export function t(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  let s = STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
