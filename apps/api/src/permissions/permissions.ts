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
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Permissions whose presence on a role makes changes to that role require a second approver (spec 8.4). */
export const SENSITIVE_PERMISSIONS: Permission[] = [
  'treasury.transfer', 'treasury.cashout.initiate', 'treasury.cashout.approve', 'treasury.funding',
  'treasury.adjustment.post', 'treasury.adjustment.approve', 'admin.administrators', 'admin.roles', 'admin.sessions',
];

/** Seeded roles of spec 8.3, each free to be rewritten in the console. */
export const SEEDED_ROLES: { name: string; description: string; permissions: Permission[] }[] = [
  { name: 'Owner', description: 'Every permission. Held by the platform owners.', permissions: ALL_PERMISSIONS },
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
