import { Inject, Injectable } from '@nestjs/common';
import { PlatformError } from '../common/errors';
import { AlertService } from '../alerts/alert.service';
import { AuditService } from '../audit/audit.service';
import { CONFIG, type AppConfig } from '../config/config';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { EntitlementService, type EntitlementInput } from './entitlement.service';

/** What a sandbox project opens with: generous limits, fees left to the route (spec: client accounts). */
const SANDBOX_LIMITS = { count_24h: 1000, value_24h: 100_000_000, count_30d: 1000, value_30d: 100_000_000 };

/** Projects that belong to a client: how a client's project opens its routes, and how a platform project is attached to a client. */
@Injectable()
export class ClientProjectsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'SANDBOX_AUTO_ENTITLE'>,
    private readonly entitlements: EntitlementService,
    private readonly alerts: AlertService,
    private readonly audit: AuditService,
  ) {}

  /** Runs in the transaction that inserted the project, so a failure leaves no project half-opened. */
  async openRoutes(tx: Tx, project: { id: string; code: string }): Promise<void> {
    if (!this.config.SANDBOX_AUTO_ENTITLE) {
      await this.alerts.raise({
        category: 'service_health', severity: 'informational', subjectType: 'project', subjectReference: project.code, projectId: project.id,
        fingerprint: `project_waiting_routes:${project.id}`, title: 'Project waiting for routes', actionReference: `/projects/${project.id}`,
      }, tx);
      return;
    }
    const routes = await tx
      .selectFrom('route as r')
      .innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null))
      .innerJoin('country as c', 'c.code', 'r.country_code')
      .select('r.id')
      .where('rv.active', '=', true)
      .where('c.active', '=', true)
      .orderBy('r.id')
      .execute();
    for (const r of routes) {
      const input: EntitlementInput = {
        route_id: r.id, minimum_amount: null, maximum_amount: null, ...SANDBOX_LIMITS,
        processing_fee_bps: null, processing_fee_fixed: null, platform_fee_bps: null, platform_fee_fixed: null, processing_fee_bearer: null, platform_fee_bearer: null,
        note: 'Opened automatically on the sandbox', accept_shortfall: true,
      };
      await this.entitlements.grantOrAmend(project.id, input, null, { tx, auditAction: 'entitlement.auto_grant' });
    }
  }

  /** Platform accounts that hold a `projects` scope on the project: they keep reaching it after the attachment. */
  async platformAccountsReaching(exec: Db | Tx, projectId: string): Promise<{ id: string; name: string }[]> {
    const rows = await exec
      .selectFrom('role_assignment as ra')
      .innerJoin('role_assignment_scope as s', 's.assignment_id', 'ra.id')
      .innerJoin('administrator as a', 'a.id', 'ra.administrator_id')
      .select(['a.id', 'a.name'])
      .where('s.project_id', '=', projectId)
      .where('ra.membership_id', 'is', null)
      .where('a.kind', '=', 'platform')
      .distinct()
      .orderBy('a.name')
      .execute();
    return rows;
  }

  async attach(tx: Tx, projectId: string, clientId: string, actorId: string, confirmationId: string) {
    const project = await tx.selectFrom('project').select(['id', 'client_id']).where('id', '=', projectId).forUpdate().executeTakeFirst();
    if (!project) throw new PlatformError('NOT_FOUND', 'No such project.');
    // A project never moves from one client to another.
    if (project.client_id) throw new PlatformError('RULE_VIOLATION', 'That project already belongs to a client.');
    const client = await tx.selectFrom('client').select(['id', 'status']).where('id', '=', clientId).executeTakeFirst();
    if (!client) throw new PlatformError('NOT_FOUND', 'No such client.');
    await tx.updateTable('project').set({ client_id: clientId }).where('id', '=', projectId).execute();
    const accounts = await this.platformAccountsReaching(tx, projectId);
    await this.audit.record(tx, { actorId, action: 'project.attach_client', subjectType: 'project', subjectId: projectId, prior: { client_id: null }, next: { client_id: clientId, platform_accounts_still_reaching: accounts }, confirmationId });
    return { project_id: projectId, client_id: clientId, platform_accounts: accounts };
  }
}
