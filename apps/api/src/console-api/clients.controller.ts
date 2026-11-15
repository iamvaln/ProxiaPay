import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { ClientsService } from '../clients/clients.service';
import { DB_TOKEN, type Db } from '../db/database';
import { nonEmpty, parseBody } from '../http/validation';
import { confirmationSchema, withConfirmation } from './confirmed-operation';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';

const confirmed = z.object({ confirmation: confirmationSchema.optional() });
const owner = z.object({ email: z.string().trim().email().max(254), language: z.enum(['en', 'fr']).optional() });
const createSchema = confirmed.extend({ name: nonEmpty(128), owner_name: nonEmpty(128), owner_email: owner.shape.email, language: owner.shape.language });
const ownerSchema = confirmed.extend({ name: nonEmpty(128), email: owner.shape.email, language: owner.shape.language });
const statusSchema = confirmed.extend({ status: z.enum(['active', 'disabled']) });

/** Clients and their memberships for ProxiaPay (spec: client accounts). Platform only: no handler here is client-accessible. */
@Controller('console/oversight/clients')
@UseGuards(SessionGuard)
export class ClientsController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly confirmations: ConfirmationService, private readonly clients: ClientsService) {}

  @Get()
  @RequirePermission('admin.clients')
  list() {
    return this.clients.list();
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('admin.clients')
  async create(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, ...input } = parseBody(createSchema, body);
    const done = await withConfirmation(this.db, this.confirmations, req.principal, 'client.create', input, confirmation, (tx) =>
      this.clients.createClient(tx, { name: input.name, ownerName: input.owner_name, ownerEmail: input.owner_email, language: input.language ?? req.principal.language }, req.principal.administratorId));
    // After the commit: a mail never carries a link to rows that rolled back.
    await done.deliver();
    return { client_id: done.clientId, status: done.status };
  }

  // The fixed-prefix routes come before ':id' so that 'memberships' and 'accounts' are never read as a client id.
  @Post('memberships/:mid/status')
  @HttpCode(200)
  @RequirePermission('admin.clients')
  async membershipStatus(@Param('mid') mid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, status } = parseBody(statusSchema, body);
    return withConfirmation(this.db, this.confirmations, req.principal, 'membership.status', { membership_id: mid, status }, confirmation, (tx) => this.clients.setMembershipStatus(tx, mid, status, req.principal.administratorId));
  }

  @Post('memberships/:mid/resend')
  @HttpCode(200)
  @RequirePermission('admin.clients')
  async resend(@Param('mid') mid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation } = parseBody(confirmed, body);
    const invited = await withConfirmation(this.db, this.confirmations, req.principal, 'membership.resend', { membership_id: mid }, confirmation, (tx) => this.clients.resend(tx, mid, req.principal.administratorId));
    await invited.deliver();
    return { status: invited.status };
  }

  @Post('accounts/:aid/disable')
  @HttpCode(200)
  @RequirePermission('admin.clients')
  async disableAccount(@Param('aid') aid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation } = parseBody(confirmed, body);
    return withConfirmation(this.db, this.confirmations, req.principal, 'administrator.disable', { administrator_id: aid }, confirmation, (tx) => this.clients.disableAccount(tx, aid, req.principal.administratorId));
  }

  @Post('accounts/:aid/enable')
  @HttpCode(200)
  @RequirePermission('admin.clients')
  async enableAccount(@Param('aid') aid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation } = parseBody(confirmed, body);
    return withConfirmation(this.db, this.confirmations, req.principal, 'administrator.enable', { administrator_id: aid }, confirmation, (tx) => this.clients.enableAccount(tx, aid, req.principal.administratorId));
  }

  @Get(':id')
  @RequirePermission('admin.clients')
  detail(@Param('id') id: string) {
    return this.clients.detail(id);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('admin.clients')
  async status(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, status } = parseBody(statusSchema, body);
    return withConfirmation(this.db, this.confirmations, req.principal, 'client.status', { client_id: id, status }, confirmation, (tx) => this.clients.setClientStatus(tx, id, status, req.principal.administratorId));
  }

  @Post(':id/owners')
  @HttpCode(201)
  @RequirePermission('admin.clients')
  async inviteOwner(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, ...input } = parseBody(ownerSchema, body);
    const invited = await withConfirmation(this.db, this.confirmations, req.principal, 'client.invite_owner', { client_id: id, ...input }, confirmation, (tx) =>
      this.clients.inviteOwner(tx, id, { name: input.name, email: input.email, language: input.language ?? req.principal.language }, req.principal.administratorId));
    await invited.deliver();
    return { status: invited.status };
  }
}
