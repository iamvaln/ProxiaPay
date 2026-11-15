import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { nonEmpty, parseBody } from '../http/validation';
import { InvitationService, isUuid } from '../clients/invitation.service';
import { ClientAccessible } from './client-access';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';

// An owner adds members, never owners: an owner is made by ProxiaPay.
const profile = z.enum(['developer', 'finance']);
const projectIds = z.array(z.string()).max(500);
const inviteSchema = z.object({ name: nonEmpty(128), email: z.string().trim().email().max(254), language: z.enum(['en', 'fr']).optional(), profile, project_ids: projectIds });
const accessSchema = z.object({ profile, project_ids: projectIds });
const statusSchema = z.object({ status: z.enum(['active', 'disabled']) });

/** The owner's team (spec: client accounts), always inside the active client: a membership of any other client does not exist here. */
@Controller('console/team')
@UseGuards(SessionGuard)
export class TeamController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly invitations: InvitationService) {}

  /** The active client of an owner. Required here as well as by the guard, since the handlers are also called directly. */
  private clientOf(req: ConsoleRequest): string {
    req.auth.require('client.members');
    if (!req.auth.isClient || !req.auth.clientId) throw new PlatformError('NOT_FOUND', 'No such resource.');
    return req.auth.clientId;
  }

  /** A membership of the active client other than the caller's own. Whether it is an owner's is checked under lock by the write itself. */
  private async member(req: ConsoleRequest, mid: string) {
    const clientId = this.clientOf(req);
    const m = isUuid(mid) ? await this.db.selectFrom('client_membership').select(['id', 'administrator_id']).where('id', '=', mid).where('client_id', '=', clientId).executeTakeFirst() : undefined;
    if (!m) throw new PlatformError('NOT_FOUND', 'No such member.');
    if (m.administrator_id === req.principal.administratorId) throw new PlatformError('PERMISSION_DENIED', 'You cannot change your own access.');
    return m;
  }

  @Get()
  @ClientAccessible()
  @RequirePermission('client.members')
  async list(@Req() req: ConsoleRequest) {
    const clientId = this.clientOf(req);
    // The owner's view leaves out the account id and who disabled a member.
    const members = (await this.invitations.membersOf(this.db, clientId)).map(({ administrator_id: _a, disabled_by_client: _d, ...m }) => m);
    return { members };
  }

  @Post()
  @ClientAccessible()
  @HttpCode(201)
  @RequirePermission('client.members')
  async invite(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const clientId = this.clientOf(req);
    const input = parseBody(inviteSchema, body);
    const invited = await this.db.transaction().execute((tx) => this.invitations.invite(tx, {
      clientId, name: input.name, email: input.email, language: input.language ?? req.principal.language, profile: input.profile, projectIds: input.project_ids,
    }, req.principal.administratorId));
    // After the commit: the mail never carries a link to rows that rolled back, and its failure is not the owner's answer.
    await invited.deliver();
    return { status: invited.status };
  }

  @Put(':mid')
  @ClientAccessible()
  @RequirePermission('client.members')
  async access(@Param('mid') mid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const m = await this.member(req, mid);
    const input = parseBody(accessSchema, body);
    return this.db.transaction().execute((tx) => this.invitations.replaceAccess(tx, m.id, input.profile, input.project_ids, req.principal.administratorId, { protectOwners: true }));
  }

  @Post(':mid/status')
  @ClientAccessible()
  @HttpCode(200)
  @RequirePermission('client.members')
  async status(@Param('mid') mid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const m = await this.member(req, mid);
    const { status } = parseBody(statusSchema, body);
    return this.db.transaction().execute((tx) => this.invitations.setStatus(tx, m.id, status, req.principal.administratorId, { protectOwners: true }));
  }

  @Post(':mid/resend')
  @ClientAccessible()
  @HttpCode(200)
  @RequirePermission('client.members')
  async resend(@Param('mid') mid: string, @Req() req: ConsoleRequest) {
    const m = await this.member(req, mid);
    const invited = await this.db.transaction().execute((tx) => this.invitations.resend(tx, m.id, req.principal.administratorId));
    await invited.deliver();
    return { status: invited.status };
  }
}
