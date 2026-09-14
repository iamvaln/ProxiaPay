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
  constructor(readonly administratorId: string, private readonly grants: Grant[]) {}

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

  async load(administratorId: string): Promise<Authorisation> {
    const rows = await this.db
      .selectFrom('role_assignment as ra')
      .innerJoin('role_permission as rp', 'rp.role_id', 'ra.role_id')
      .leftJoin('role_assignment_scope as s', 's.assignment_id', 'ra.id')
      .select(['ra.id as assignment_id', 'rp.permission_key', 'ra.scope_type', 's.project_id', 's.provider_account_id'])
      .where('ra.administrator_id', '=', administratorId)
      .execute();
    const byAssignment = new Map<string, Grant[]>();
    for (const r of rows) {
      const list = byAssignment.get(r.assignment_id) ?? [];
      let grant = list.find((g) => g.permission === r.permission_key);
      if (!grant) {
        grant = { permission: r.permission_key as Permission, scopeType: r.scope_type as Grant['scopeType'], projectIds: [], providerAccountIds: [] };
        list.push(grant);
      }
      if (r.project_id) grant.projectIds.push(r.project_id);
      if (r.provider_account_id) grant.providerAccountIds.push(r.provider_account_id);
      byAssignment.set(r.assignment_id, list);
    }
    return new Authorisation(administratorId, [...byAssignment.values()].flat());
  }
}
