import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { parseBody } from '../http/validation';
import { LinksService, linkInputSchema } from '../payment-links/links.service';
import { ClientAccessible } from './client-access';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';
import type { Permission } from '../permissions/permissions';

/** A project's payment links: read by anyone who reads the project, made and disabled by whoever manages links. */
@Controller('console/projects/:id/payment-links')
@UseGuards(SessionGuard)
export class PaymentLinksController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly links: LinksService) {}

  /** The permission first (a developer is told what is missing), then the project (another client's project does not exist). */
  private reach(req: ConsoleRequest, projectId: string, permission: Permission) {
    req.auth.require(permission);
    if (!req.auth.canReachProject(permission, projectId)) throw new PlatformError('NOT_FOUND', 'No such project.');
  }

  @Get()
  @ClientAccessible()
  @RequirePermission('projects.read')
  async list(@Param('id') id: string, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.read');
    return { links: await this.links.list(id) };
  }

  @Post()
  @ClientAccessible()
  @HttpCode(201)
  @RequirePermission('links.manage')
  async create(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'links.manage');
    const input = parseBody(linkInputSchema, body);
    return this.db.transaction().execute((tx) => this.links.create(tx, id, input, req.principal.administratorId));
  }

  /** The link is looked up inside the project in the path: a link of another project does not exist here. */
  @Get(':lid')
  @ClientAccessible()
  @RequirePermission('projects.read')
  async detail(@Param('id') id: string, @Param('lid') lid: string, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.read');
    return this.links.detail(id, lid);
  }

  @Post(':lid/disable')
  @ClientAccessible()
  @HttpCode(200)
  @RequirePermission('links.manage')
  async disable(@Param('id') id: string, @Param('lid') lid: string, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'links.manage');
    return this.db.transaction().execute((tx) => this.links.disable(tx, id, lid, req.principal.administratorId));
  }
}
