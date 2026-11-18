import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { AlertService } from '../alerts/alert.service';
import { AuditService } from '../audit/audit.service';
import { ClientsService } from '../clients/clients.service';
import { InvitationService } from '../clients/invitation.service';
import { ClientProjectsService } from '../console-api/client-projects.service';
import { EntitlementService } from '../console-api/entitlement.service';
import { setUpHousePartner } from './house-partner-setup';

let t: TestContext;
beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

function services() {
  const audit = t.app.get(AuditService);
  const clients = new ClientsService(t.db, {} as InvitationService, audit); // the CLI invites nobody
  const clientProjects = new ClientProjectsService(t.db, { SANDBOX_AUTO_ENTITLE: false }, new EntitlementService(t.db, audit), t.app.get(AlertService), audit);
  return { clients, clientProjects };
}
const run = (ownerEmail: string, projectCodes: string[]) => setUpHousePartner(t.db, services(), { name: 'Proxia Digital', ownerEmail, projectCodes });

describe('the house partner CLI', () => {
  it('idempotent: twice gives one client, one membership, the projects attached once', async () => {
    const owner = await t.admin('val@proxia.test');
    await t.project('monjeton');
    await t.project('other');
    const first = await run(owner.email, ['monjeton', 'other']);
    expect(first).toHaveLength(4);
    expect(await run(owner.email, ['monjeton', 'other'])).toEqual([]);

    const clients = await t.db.selectFrom('client').select(['id', 'name']).execute();
    expect(clients.map((c) => c.name)).toEqual(['Proxia Digital']);
    const members = await t.db.selectFrom('client_membership').select(['administrator_id', 'status']).execute();
    expect(members).toEqual([{ administrator_id: owner.id, status: 'active' }]);
    const roles = await t.db.selectFrom('role_assignment as ra').innerJoin('role as r', 'r.id', 'ra.role_id').select(['r.name', 'ra.scope_type']).where('ra.membership_id', 'is not', null).execute();
    expect(roles).toEqual([{ name: 'Client owner', scope_type: 'client' }]);
    const projects = await t.db.selectFrom('project').select('client_id').execute();
    expect(projects.every((p) => p.client_id === clients[0]!.id)).toBe(true);
    // No invitation goes out: the owner is the existing account.
    expect(await t.db.selectFrom('client_membership').select('id').where('status', '=', 'pending').execute()).toEqual([]);

    const audit = await t.db.selectFrom('audit_record').select(['action', 'actor_id']).where('action', 'in', ['client.create', 'project.attach_client', 'client.attach_self', 'client.invite_owner']).execute();
    expect(audit.map((a) => a.action).sort()).toEqual(['client.attach_self', 'client.create', 'project.attach_client', 'project.attach_client']);
    expect(audit.every((a) => a.actor_id === owner.id)).toBe(true);
  });

  it('refuses a project of another client and keeps nothing', async () => {
    const owner = await t.admin('val@proxia.test');
    await t.project('monjeton');
    await t.project('acme-shop');
    const acme = await t.db.insertInto('client').values({ name: 'Acme' }).returning('id').executeTakeFirstOrThrow();
    await t.db.updateTable('project').set({ client_id: acme.id }).where('code', '=', 'acme-shop').execute();
    await expect(run(owner.email, ['monjeton', 'acme-shop'])).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
    expect((await t.db.selectFrom('client').select('name').execute()).map((c) => c.name)).toEqual(['Acme']);
    expect(await t.db.selectFrom('client_membership').select('id').execute()).toEqual([]);
    expect((await t.db.selectFrom('project').select('client_id').where('code', '=', 'monjeton').executeTakeFirstOrThrow()).client_id).toBeNull();
  });

  it('refuses an unknown project, an unknown account and a client account', async () => {
    const owner = await t.admin('val@proxia.test');
    await expect(run(owner.email, ['nope'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run('nobody@proxia.test', [])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', owner.id).execute();
    await expect(run(owner.email, [])).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
  });
});
