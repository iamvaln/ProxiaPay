import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { parseBody } from '../http/validation';
import { BrandService } from '../payment-links/brand.service';
import { LOGO_MESSAGE, MAX_LOGO_BYTES } from '../payment-links/brand';
import { ClientAccessible } from './client-access';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';
import type { Permission } from '../permissions/permissions';

const colorsSchema = z.object({ primary_color: z.string(), secondary_color: z.string().nullish() });
// The base64 of the largest logo, with room for padding: a longer string is refused before it is decoded.
const logoSchema = z.object({ data_base64: z.string().max(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 8) });

/** The project's brand (spec: payment links): read by anyone who reads the project, changed by whoever manages links. */
@Controller('console/projects/:id/brand')
@UseGuards(SessionGuard)
export class BrandController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly brand: BrandService) {}

  /** The permission first (a developer is told what is missing), then the project (another client's project does not exist). */
  private reach(req: ConsoleRequest, projectId: string, permission: Permission) {
    req.auth.require(permission);
    if (!req.auth.canReachProject(permission, projectId)) throw new PlatformError('NOT_FOUND', 'No such project.');
  }

  @Get()
  @ClientAccessible()
  @RequirePermission('projects.read')
  async get(@Param('id') id: string, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.read');
    return this.brand.get(id);
  }

  @Put()
  @ClientAccessible()
  @RequirePermission('links.manage')
  async setColors(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'links.manage');
    const colors = parseBody(colorsSchema, body);
    return this.db.transaction().execute((tx) => this.brand.setColors(tx, id, colors, req.principal.administratorId));
  }

  @Post('logo')
  @ClientAccessible()
  @HttpCode(201)
  @RequirePermission('links.manage')
  async setLogo(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'links.manage');
    const parsed = logoSchema.safeParse(body);
    if (!parsed.success) throw new PlatformError('FIELD_INVALID', LOGO_MESSAGE, { field: 'logo' });
    const bytes = Buffer.from(parsed.data.data_base64, 'base64');
    return this.db.transaction().execute((tx) => this.brand.setLogo(tx, id, bytes, req.principal.administratorId));
  }
}
