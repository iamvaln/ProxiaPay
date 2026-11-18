/** The permission catalogue of spec 8.2. Each key is one operation the platform performs. */
export const PERMISSIONS = {
  // Reference data
  'reference.read': 'Read countries and payment methods',
  'reference.manage': 'Manage countries and payment methods',
  // Routes
  'routes.read': 'Read routes and their history',
  'routes.open_version': 'Open route versions',
  'routes.set_fees': 'Set fee terms on routes',
  // Providers
  'providers.read': 'Read provider accounts',
  'providers.manage': 'Manage provider accounts and credentials',
  'providers.suspend': 'Suspend and restore a provider account',
  // Projects
  'projects.read': 'Read projects',
  'projects.manage': 'Create and manage projects',
  'projects.credentials': 'Issue, promote, demote, delete and revoke project credentials',
  'projects.origins': 'Manage declared origins',
  'projects.entitlements': 'Manage entitlements',
  'projects.notifications': 'Manage notification endpoints',
  // Treasury
  'treasury.read_balances': 'Read balances',
  'treasury.read_float': 'Read float',
  'treasury.transfer': 'Initiate float transfers',
  'treasury.cashout.initiate': 'Initiate cashouts',
  'treasury.cashout.approve': 'Approve cashouts',
  'treasury.funding': 'Post funding',
  'treasury.adjustment.post': 'Post adjustments',
  'treasury.adjustment.approve': 'Approve adjustments',
  // Transactions
  'transactions.read': 'Search and read transactions',
  'transactions.read_identifiers': 'Read unmasked payer identifiers',
  'transactions.read_exchanges': 'Read raw provider exchanges',
  'transactions.recheck': 'Force a status re-check',
  'transactions.replay_notification': 'Replay a notification',
  'transactions.refund': 'Initiate a refund',
  // Reconciliation
  'reconciliation.read': 'Read runs and discrepancies',
  'reconciliation.upload': 'Upload provider statements',
  'reconciliation.run': 'Run reconciliation',
  'reconciliation.decide': 'Accept or reject discrepancies',
  'reconciliation.approve_adjustment': 'Approve adjustments arising from discrepancies',
  // Oversight
  'oversight.reports': 'Read reports',
  'oversight.export': 'Export data',
  'oversight.verify_export': 'Verify an export',
  'oversight.audit': 'Read the audit log',
  'oversight.auth_history': 'Read authentication history',
  'oversight.alerts.read': 'Read alerts',
  'oversight.alerts.acknowledge': 'Acknowledge alerts',
  'oversight.alerts.manage': 'Manage alert policies and groups',
  // Administration
  'admin.administrators': 'Manage administrators',
  'admin.roles': 'Manage roles',
  'admin.sessions': 'Revoke sessions',
  'admin.clients': 'Manage clients and their owners',
  // Client accounts: held only by roles of kind 'client'
  'projects.create_own': 'Create projects for one\'s own client',
  'client.members': 'Manage one\'s own client team',
  'links.manage': 'Create and manage payment links and project branding',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Permissions that only make sense inside a client: platform roles, Owner included, never hold them.
 * `links.manage` is one: only a partner makes links and sets a brand, on its own projects, so the
 * platform reaches them only from a partner's view.
 */
export const CLIENT_ONLY_PERMISSIONS: Permission[] = ['projects.create_own', 'client.members', 'links.manage'];
export const PLATFORM_PERMISSIONS = ALL_PERMISSIONS.filter((p) => !CLIENT_ONLY_PERMISSIONS.includes(p));

/** Permissions whose presence on a role makes changes to that role require a second approver (spec 8.4). */
export const SENSITIVE_PERMISSIONS: Permission[] = [
  'treasury.transfer', 'treasury.cashout.initiate', 'treasury.cashout.approve', 'treasury.funding',
  'treasury.adjustment.post', 'treasury.adjustment.approve', 'admin.administrators', 'admin.roles', 'admin.sessions', 'admin.clients',
];

/** Seeded roles of spec 8.3, each free to be rewritten in the console. */
export const SEEDED_ROLES: { name: string; description: string; permissions: Permission[] }[] = [
  { name: 'Owner', description: 'Every permission. Held by the platform owners.', permissions: PLATFORM_PERMISSIONS },
  {
    name: 'Configuration',
    description: 'Reference data, routes, providers and projects.',
    permissions: ['reference.read', 'reference.manage', 'routes.read', 'routes.open_version', 'routes.set_fees', 'providers.read', 'providers.manage', 'providers.suspend',
      'projects.read', 'projects.manage', 'projects.credentials', 'projects.origins', 'projects.entitlements', 'projects.notifications', 'oversight.audit'],
  },
  {
    name: 'Treasury',
    description: 'Balances, float, transfers, cashouts, funding and adjustments.',
    permissions: ['treasury.read_balances', 'treasury.read_float', 'treasury.transfer', 'treasury.cashout.initiate', 'treasury.cashout.approve', 'treasury.funding',
      'treasury.adjustment.post', 'treasury.adjustment.approve', 'reconciliation.read', 'reconciliation.upload', 'reconciliation.run', 'reconciliation.decide',
      'reconciliation.approve_adjustment', 'oversight.reports', 'oversight.export', 'oversight.alerts.read', 'oversight.alerts.acknowledge', 'projects.read', 'routes.read', 'providers.read', 'transactions.read'],
  },
  {
    name: 'Support',
    description: 'Investigation of individual payments.',
    permissions: ['transactions.read', 'transactions.read_identifiers', 'transactions.recheck', 'transactions.replay_notification', 'projects.read', 'routes.read', 'reference.read', 'oversight.alerts.read'],
  },
  {
    name: 'Project team',
    description: 'Read access for the team owning a project, scoped to it.',
    permissions: ['transactions.read', 'projects.read', 'treasury.read_balances', 'routes.read', 'reference.read'],
  },
  {
    name: 'Analysis',
    description: 'Reporting and export.',
    permissions: ['oversight.reports', 'oversight.export', 'transactions.read', 'projects.read', 'routes.read', 'reference.read', 'providers.read', 'treasury.read_balances', 'treasury.read_float'],
  },
  {
    name: 'Audit',
    description: 'Read-only oversight, including export verification.',
    permissions: ['oversight.audit', 'oversight.auth_history', 'oversight.verify_export', 'oversight.reports', 'transactions.read', 'reconciliation.read', 'routes.read', 'projects.read', 'providers.read', 'reference.read', 'treasury.read_balances', 'treasury.read_float'],
  },
];

/** Roles of client accounts; `profile` is the key the client team API uses. Never assignable to platform administrators. */
export const CLIENT_ROLES: { name: string; description: string; profile: 'owner' | 'developer' | 'finance'; permissions: Permission[] }[] = [
  {
    name: 'Client owner',
    description: 'Runs a client: its projects, credentials and team.',
    profile: 'owner',
    permissions: ['transactions.read', 'projects.read', 'projects.create_own', 'projects.credentials', 'projects.origins', 'projects.notifications',
      'treasury.read_balances', 'oversight.export', 'client.members', 'links.manage'],
  },
  {
    name: 'Client developer',
    description: 'Integrates a client\'s projects: credentials, origins and notifications.',
    profile: 'developer',
    permissions: ['transactions.read', 'projects.read', 'projects.credentials', 'projects.origins', 'projects.notifications', 'treasury.read_balances'],
  },
  {
    name: 'Client finance',
    description: 'Reads a client\'s payments and balances, and exports them.',
    profile: 'finance',
    permissions: ['transactions.read', 'projects.read', 'treasury.read_balances', 'oversight.export'],
  },
];
