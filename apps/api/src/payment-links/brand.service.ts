import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PlatformError } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { COLOR_FORMAT_MESSAGE, COLOR_MESSAGE, DEFAULT_PRIMARY_COLOR, LOGO_MESSAGE, MAX_LOGO_BYTES, isHexColor, isUsableColor, logoType } from './brand';

export interface Brand { logo_asset_id: string | null; primary_color: string; secondary_color: string | null }

/** A project's logo and colours, set once by its owner; each new link starts from them. */
@Injectable()
export class BrandService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly audit: AuditService) {}

  async get(projectId: string): Promise<Brand> {
    const row = await this.db.selectFrom('project_brand').select(['logo_asset_id', 'primary_color', 'secondary_color']).where('project_id', '=', projectId).executeTakeFirst();
    return row ?? { logo_asset_id: null, primary_color: DEFAULT_PRIMARY_COLOR, secondary_color: null };
  }

  async setLogo(tx: Tx, projectId: string, bytes: Buffer, actorId: string): Promise<{ asset_id: string }> {
    const type = bytes.length <= MAX_LOGO_BYTES ? logoType(bytes) : null;
    if (!type) throw new PlatformError('FIELD_INVALID', LOGO_MESSAGE, { field: 'logo' });
    const asset = await tx.insertInto('brand_asset')
      .values({ project_id: projectId, bytes, content_type: type, sha256: createHash('sha256').update(bytes).digest('hex') })
      .returning('id').executeTakeFirstOrThrow();
    const prior = await this.current(tx, projectId);
    await tx.insertInto('project_brand').values({ project_id: projectId, logo_asset_id: asset.id, primary_color: DEFAULT_PRIMARY_COLOR })
      .onConflict((oc) => oc.column('project_id').doUpdateSet({ logo_asset_id: asset.id })).execute();
    await this.audit.record(tx, { actorId, action: 'brand.logo', subjectType: 'project', subjectId: projectId, prior: { logo_asset_id: prior.logo_asset_id }, next: { logo_asset_id: asset.id } });
    return { asset_id: asset.id };
  }

  async setColors(tx: Tx, projectId: string, colors: { primary_color: string; secondary_color?: string | null }, actorId: string): Promise<Brand> {
    const secondary = colors.secondary_color ?? null;
    for (const [field, value] of [['primary_color', colors.primary_color], ['secondary_color', secondary]] as const) {
      if (value === null) continue;
      if (!isHexColor(value)) throw new PlatformError('FIELD_INVALID', COLOR_FORMAT_MESSAGE, { field });
      if (!isUsableColor(value)) throw new PlatformError('FIELD_INVALID', COLOR_MESSAGE, { field });
    }
    const prior = await this.current(tx, projectId);
    await tx.insertInto('project_brand').values({ project_id: projectId, primary_color: colors.primary_color, secondary_color: secondary })
      .onConflict((oc) => oc.column('project_id').doUpdateSet({ primary_color: colors.primary_color, secondary_color: secondary })).execute();
    await this.audit.record(tx, { actorId, action: 'brand.colors', subjectType: 'project', subjectId: projectId, prior: { primary_color: prior.primary_color, secondary_color: prior.secondary_color }, next: { primary_color: colors.primary_color, secondary_color: secondary } });
    return { logo_asset_id: prior.logo_asset_id, primary_color: colors.primary_color, secondary_color: secondary };
  }

  private async current(tx: Tx, projectId: string): Promise<Brand> {
    const row = await tx.selectFrom('project_brand').select(['logo_asset_id', 'primary_color', 'secondary_color']).where('project_id', '=', projectId).forUpdate().executeTakeFirst();
    return row ?? { logo_asset_id: null, primary_color: DEFAULT_PRIMARY_COLOR, secondary_color: null };
  }
}
