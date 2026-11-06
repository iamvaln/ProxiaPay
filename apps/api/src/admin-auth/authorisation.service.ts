import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN, type Db } from '../db/database';
import type { Permission } from '../permissions/permissions';
import { PlatformError } from '../common/errors';

export interface Grant {
  permission: Permission;
  scopeType: 'all' | 'projects' | 'provider_accounts';
  projectIds: string[];
  providerAccountIds: string[];
}

/**
 * What an administrator may do and over which projects or provider accounts (spec 8.3).
 * Scope is enforced where data is read, so callers ask for the reachable set and filter with it.
 */
export class Authorisation {
  private readonly clientAccount: boolean;

  /** `clientId` is the active client of a client account; null for platform staff, and for a client account that has none yet. */
  constructor(readonly administratorId: string, private readonly grants: Grant[], readonly clientId: string | null = null, clientAccount?: boolean) {
    this.clientAccount = clientAccount ?? clientId !== null;
  }

  get isClient(): boolean {
    return this.clientAccount;
  }

  has(permission: Permission): boolean {
    return this.grants.some((g) => g.permission === permission);
  }

  require(permission: Permission): void {
    if (!this.has(permission)) throw new PlatformError('PERMISSION_DENIED', `This operation requires the permission "${permission}".`, { details: { permission } });
  }

  permissions(): Permission[] {
    return [...new Set(this.grants.map((g) => g.permission))];
  }

  /** null means every project; an array limits to those listed. */
  projectScope(permission: Permission): string[] | null {
    const relevant = this.grants.filter((g) => g.permission === permission);
    if (relevant.some((g) => g.scopeType === 'all')) return null;
    return [...new Set(relevant.flatMap((g) => g.projectIds))];
  }

  providerScope(permission: Permission): string[] | null {
    const relevant = this.grants.filter((g) => g.permission === permission);
    if (relevant.some((g) => g.scopeType === 'all')) return null;
    return [...new Set(relevant.flatMap((g) => g.providerAccountIds))];
  }

  canReachProject(permission: Permission, projectId: string): boolean {
    const scope = this.projectScope(permission);
    return scope === null || scope.includes(projectId);
  }

  canReachProvider(permission: Permission, providerAccountId: string): boolean {
    const scope = this.providerScope(permission);
    return scope === null || scope.includes(providerAccountId);
  }

  /** Records that a scoped view is partial, for figures that must say what they cover. */
  isScoped(permission: Permission): boolean {
    return this.projectScope(permission) !== null || this.providerScope(permission) !== null;
  }
}

@Injectable()
export class AuthorisationService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async load(administratorId: string, activeClientId: string | null): Promise<Authorisation> {
    const admin = await this.db.selectFrom('administrator').select('kind').where('id', '=', administratorId).executeTakeFirst();
    if (admin?.kind === 'client') return this.loadClient(administratorId, activeClientId);
    // Platform staff: only assignments that belong to no membership.
    const rows = await this.db
      .selectFrom('role_assignment as ra')
      .innerJoin('role_permission as rp', 'rp.role_id', 'ra.role_id')
      .leftJoin('role_assignment_scope as s', 's.assignment_id', 'ra.id')
      .select(['ra.id as assignment_id', 'rp.permission_key', 'ra.scope_type', 's.project_id', 's.provider_account_id'])
      .where('ra.administrator_id', '=', administratorId)
      .where('ra.membership_id', 'is', null)
      .execute();
    return new Authorisation(administratorId, this.grantsOf(rows, [], false), null, false);
  }

  /** A client account is authorised by its active membership alone; the other memberships of the same person count for nothing. */
  private async loadClient(administratorId: string, activeClientId: string | null): Promise<Authorisation> {
    if (!activeClientId) return new Authorisation(administratorId, [], null, true);
    const rows = await this.db
      .selectFrom('role_assignment as ra')
      .innerJoin('client_membership as m', 'm.id', 'ra.membership_id')
      .innerJoin('client as c', 'c.id', 'm.client_id')
      .innerJoin('role_permission as rp', 'rp.role_id', 'ra.role_id')
      .leftJoin('role_assignment_scope as s', 's.assignment_id', 'ra.id')
      .select(['ra.id as assignment_id', 'rp.permission_key', 'ra.scope_type', 's.project_id', 's.provider_account_id'])
      .where('ra.administrator_id', '=', administratorId)
      .where('m.administrator_id', '=', administratorId)
      .where('m.client_id', '=', activeClientId)
      .where('m.status', '=', 'active')
      .where('c.status', '=', 'active')
      .execute();
    if (rows.length === 0) return new Authorisation(administratorId, [], activeClientId, true);
    // Resolved at load time, so a project created after the assignment is covered.
    const projects = await this.db.selectFrom('project').select('id').where('client_id', '=', activeClientId).execute();
    return new Authorisation(administratorId, this.grantsOf(rows, projects.map((p) => p.id), true), activeClientId, true);
  }

  private grantsOf(
    rows: { assignment_id: string; permission_key: string; scope_type: string; project_id: string | null; provider_account_id: string | null }[],
    clientProjectIds: string[],
    clientAccount: boolean,
  ): Grant[] {
    const byAssignment = new Map<string, Grant[]>();
    for (const r of rows) {
      const list = byAssignment.get(r.assignment_id) ?? [];
      let grant = list.find((g) => g.permission === r.permission_key);
      if (!grant) {
        const isClientScope = r.scope_type === 'client';
        grant = {
          permission: r.permission_key as Permission,
          scopeType: isClientScope ? 'projects' : (r.scope_type as Grant['scopeType']),
          projectIds: isClientScope ? [...clientProjectIds] : [],
          providerAccountIds: [],
        };
        list.push(grant);
      }
      if (r.project_id) grant.projectIds.push(r.project_id);
      if (r.provider_account_id) grant.providerAccountIds.push(r.provider_account_id);
      byAssignment.set(r.assignment_id, list);
    }
    const grants = [...byAssignment.values()].flat();
    if (!clientAccount) return grants;
    // Whatever its scope_type, a client account's grant never reaches beyond the active client's projects.
    const own = new Set(clientProjectIds);
    return grants.map((g) => ({
      permission: g.permission,
      scopeType: 'projects',
      projectIds: g.scopeType === 'provider_accounts' ? [] : (g.scopeType === 'all' ? [...own] : g.projectIds.filter((id) => own.has(id))),
      providerAccountIds: [],
    }));
  }
}
