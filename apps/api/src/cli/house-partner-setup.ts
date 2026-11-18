import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import type { Db } from '../db/database';
import type { ClientsService } from '../clients/clients.service';
import type { ClientProjectsService } from '../console-api/client-projects.service';

export interface HousePartnerInput {
  name: string;
  ownerEmail: string;
  projectCodes: string[];
}

/**
 * Sets up the house partner, in one transaction and by the same rules as the console paths: finds or creates the client by name
 * (with no owner invitation), attaches each project (a project of another client is refused and nothing is kept), and gives the
 * platform account an active owner membership. Idempotent; returns what it did, empty when there was nothing to do.
 */
export async function setUpHousePartner(db: Db, services: { clients: ClientsService; clientProjects: ClientProjectsService }, input: HousePartnerInput): Promise<string[]> {
  return db.transaction().execute(async (tx) => {
    const done: string[] = [];
    const name = input.name.trim();
    const owner = await tx.selectFrom('administrator').select(['id', 'kind', 'status']).where('email', '=', input.ownerEmail.trim().toLowerCase()).executeTakeFirst();
    if (!owner) throw new PlatformError('NOT_FOUND', `No account with the email ${input.ownerEmail}.`);
    if (owner.kind !== 'platform') throw new PlatformError('RULE_VIOLATION', 'The owner must be a platform account.');
    if (owner.status !== 'active') throw new PlatformError('RULE_VIOLATION', 'The owner account is not active.');

    const found = await tx.selectFrom('client').select('id').where(sql`lower(trim(name))`, '=', name.toLowerCase()).execute();
    if (found.length > 1) throw new PlatformError('CONFLICT', `More than one client is named ${name}.`);
    let clientId = found[0]?.id;
    if (!clientId) {
      clientId = (await services.clients.createWithoutInvite(tx, name, owner.id)).id;
      done.push(`created the client ${name}`);
    }

    for (const code of input.projectCodes) {
      const project = await tx.selectFrom('project').select(['id', 'client_id']).where('code', '=', code).executeTakeFirst();
      if (!project) throw new PlatformError('NOT_FOUND', `No project with the code ${code}.`);
      if (project.client_id === clientId) continue;
      // Refuses a project that belongs to another client, as the console does.
      await services.clientProjects.attach(tx, project.id, clientId, owner.id, null);
      done.push(`attached the project ${code}`);
    }

    const membership = await tx.selectFrom('client_membership').select('status').where('client_id', '=', clientId).where('administrator_id', '=', owner.id).executeTakeFirst();
    if (!membership) {
      await services.clients.attachSelf(tx, clientId, owner.id, null);
      done.push(`made ${input.ownerEmail} an owner of ${name}`);
    } else if (membership.status !== 'active') {
      throw new PlatformError('RULE_VIOLATION', `${input.ownerEmail} already has a ${membership.status} membership; re-enable it from the client page.`);
    }
    return done;
  });
}
