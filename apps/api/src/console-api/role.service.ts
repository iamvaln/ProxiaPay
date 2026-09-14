import { Inject, Injectable } from '@nestjs/common';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { ALL_PERMISSIONS, SENSITIVE_PERMISSIONS, type Permission } from '../permissions/permissions';
import { AuditService } from '../audit/audit.service';
import { AlertService } from '../alerts/alert.service';

export interface RoleChange {
  kind: 'role_permissions' | 'assignment_add' | 'assignment_remove';
  role_id?: string;
  name?: string;
  description?: string;
  permissions?: Permission[];
  administrator_id?: string;
  assignment_id?: string;
  scope_type?: 'all' | 'projects' | 'provider_accounts';
  project_ids?: string[];
  provider_account_ids?: string[];
}

/**
 * Roles and assignments (spec 8.3, 8.4): editable data, audited like configuration, with
 * changes to roles carrying treasury or administration permissions held for a second approver,
 * and an administrator never able to alter their own roles or scope.
 */
@Injectable()
export class RoleService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly audit: AuditService, private readonly alerts: AlertService) {}

  async list() {
    const roles = await this.db.selectFrom('role').selectAll().orderBy('name').execute();
    const perms = await this.db.selectFrom('role_permission').selectAll().execute();
    const assignments = await this.db.selectFrom('role_assignment as ra').innerJoin('administrator as a', 'a.id', 'ra.administrator_id').select(['ra.role_id', 'a.id', 'a.name']).execute();
    return roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission_key), administrators: assignments.filter((a) => a.role_id === r.id).map((a) => ({ id: a.id, name: a.name })) }));
  }

  /** What a change touches, named before committing (console spec 10.6). */
  async impact(change: RoleChange) {
    if (change.kind === 'role_permissions' && change.role_id) {
      const current = (await this.db.selectFrom('role_permission').select('permission_key').where('role_id', '=', change.role_id).execute()).map((p) => p.permission_key);
      const next = change.permissions ?? [];
      const granted = next.filter((p) => !current.includes(p));
      const removed = current.filter((p) => !next.includes(p as Permission));
      const admins = await this.db.selectFrom('role_assignment as ra').innerJoin('administrator as a', 'a.id', 'ra.administrator_id').select(['a.id', 'a.name']).where('ra.role_id', '=', change.role_id).execute();
      return { granted, removed, administrators: admins, requires_approval: this.requiresApproval([...current, ...next] as Permission[]) };
    }
    return { requires_approval: false };
  }

  requiresApproval(permissions: Permission[]): boolean {
    return permissions.some((p) => SENSITIVE_PERMISSIONS.includes(p));
  }

  /** Validates and either applies a change or queues it for approval. */
  async propose(change: RoleChange, actor: { id: string; permissions: string[] }, justification: string, confirmationId?: string): Promise<{ status: 'applied' | 'pending_approval' }> {
    for (const p of change.permissions ?? []) if (!ALL_PERMISSIONS.includes(p)) throw new PlatformError('FIELD_INVALID', `Unknown permission ${p}.`, { field: 'permissions' });
    if (change.administrator_id === actor.id) throw new PlatformError('PERMISSION_DENIED', 'An administrator cannot alter their own roles or scope.');
    if (change.kind === 'assignment_remove' && change.assignment_id) {
      const a = await this.db.selectFrom('role_assignment').select('administrator_id').where('id', '=', change.assignment_id).executeTakeFirst();
      if (a?.administrator_id === actor.id) throw new PlatformError('PERMISSION_DENIED', 'An administrator cannot alter their own roles or scope.');
    }
    let sensitive = false;
    if (change.kind === 'role_permissions' && change.role_id) {
      const current = (await this.db.selectFrom('role_permission').select('permission_key').where('role_id', '=', change.role_id).execute()).map((p) => p.permission_key as Permission);
      sensitive = this.requiresApproval([...current, ...(change.permissions ?? [])]);
    } else if (change.role_id) {
      const perms = (await this.db.selectFrom('role_permission').select('permission_key').where('role_id', '=', change.role_id).execute()).map((p) => p.permission_key as Permission);
      sensitive = this.requiresApproval(perms);
    } else if (change.assignment_id) {
      const perms = (await this.db.selectFrom('role_assignment as ra').innerJoin('role_permission as rp', 'rp.role_id', 'ra.role_id').select('rp.permission_key').where('ra.id', '=', change.assignment_id).execute()).map((p) => p.permission_key as Permission);
      sensitive = this.requiresApproval(perms);
    }
    return this.db.transaction().execute(async (tx) => {
      if (sensitive) {
        const req = await tx.insertInto('approval_request').values({ type: 'role_change', subject: JSON.stringify(change), summary: describe(change), initiated_by: actor.id, justification }).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(tx, { actorId: actor.id, action: 'role_change.queued', subjectType: 'approval_request', subjectId: req.id, next: change, confirmationId });
        await this.alerts.raise({ category: 'security', severity: 'informational', subjectType: 'role', subjectReference: change.role_id ?? change.assignment_id ?? 'new', fingerprint: `approval:role:${change.role_id ?? req.id}`, title: 'Role change awaiting a second approver', detail: { summary: describe(change) }, actionReference: '/approvals' }, tx);
        return { status: 'pending_approval' as const };
      }
      await this.applyChange(tx, change, actor.id, null, confirmationId);
      return { status: 'applied' as const };
    });
  }

  async applyChange(tx: Tx, change: RoleChange, actorId: string, approverId: string | null, confirmationId?: string): Promise<void> {
    if (change.kind === 'role_permissions') {
      let roleId = change.role_id;
      let prior: unknown = null;
      if (!roleId) {
        if (!change.name) throw new PlatformError('FIELD_INVALID', 'A new role needs a name.', { field: 'name' });
        roleId = (await tx.insertInto('role').values({ name: change.name, description: change.description ?? '' }).returning('id').executeTakeFirstOrThrow()).id;
      } else {
        prior = { permissions: (await tx.selectFrom('role_permission').select('permission_key').where('role_id', '=', roleId).execute()).map((p) => p.permission_key) };
        if (change.name || change.description !== undefined) await tx.updateTable('role').set({ ...(change.name ? { name: change.name } : {}), ...(change.description !== undefined ? { description: change.description } : {}) }).where('id', '=', roleId).execute();
        await tx.deleteFrom('role_permission').where('role_id', '=', roleId).execute();
      }
      if (change.permissions?.length) await tx.insertInto('role_permission').values(change.permissions.map((p) => ({ role_id: roleId!, permission_key: p }))).execute();
      await this.audit.record(tx, { actorId, action: 'role.set_permissions', subjectType: 'role', subjectId: roleId, prior, next: { name: change.name, permissions: change.permissions }, approvedBy: approverId, confirmationId });
      await this.alerts.raise({ category: 'security', severity: 'informational', subjectType: 'role', subjectReference: roleId, fingerprint: `role_changed:${roleId}:${Date.now()}`, title: 'Role permissions changed', detail: { permissions: change.permissions }, actionReference: `/oversight/roles/${roleId}` }, tx);
      return;
    }
    if (change.kind === 'assignment_add') {
      if (!change.administrator_id || !change.role_id || !change.scope_type) throw new PlatformError('FIELD_INVALID', 'An assignment names an administrator, a role and a scope.');
      const a = await tx.insertInto('role_assignment').values({ administrator_id: change.administrator_id, role_id: change.role_id, scope_type: change.scope_type, granted_by: actorId }).returning('id').executeTakeFirstOrThrow();
      const scopes = [...(change.project_ids ?? []).map((p) => ({ assignment_id: a.id, project_id: p, provider_account_id: null })), ...(change.provider_account_ids ?? []).map((p) => ({ assignment_id: a.id, project_id: null, provider_account_id: p }))];
      if (change.scope_type !== 'all' && scopes.length === 0) throw new PlatformError('FIELD_INVALID', 'A scoped assignment names at least one project or provider account.');
      if (scopes.length) await tx.insertInto('role_assignment_scope').values(scopes).execute();
      await this.audit.record(tx, { actorId, action: 'role_assignment.add', subjectType: 'administrator', subjectId: change.administrator_id, next: change, approvedBy: approverId, confirmationId });
      return;
    }
    if (change.kind === 'assignment_remove' && change.assignment_id) {
      const prior = await tx.selectFrom('role_assignment').selectAll().where('id', '=', change.assignment_id).executeTakeFirst();
      await tx.deleteFrom('role_assignment').where('id', '=', change.assignment_id).execute();
      await this.audit.record(tx, { actorId, action: 'role_assignment.remove', subjectType: 'administrator', subjectId: prior?.administrator_id ?? 'unknown', prior, approvedBy: approverId, confirmationId });
    }
  }
}

function describe(c: RoleChange): string {
  if (c.kind === 'role_permissions') return c.role_id ? `Change permissions of role ${c.name ?? c.role_id}` : `Create role ${c.name}`;
  if (c.kind === 'assignment_add') return `Assign role ${c.role_id} to administrator ${c.administrator_id} (${c.scope_type})`;
  return `Remove role assignment ${c.assignment_id}`;
}
