import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { AuthorisationService } from '../admin-auth/authorisation.service';
import { AuditService } from '../audit/audit.service';
import { BrandController } from '../console-api/brand.controller';
import type { ConsoleRequest } from '../console-api/session.guard';
import { MAX_LOGO_BYTES, contrastWithWhite, isUsableColor, logoType } from './brand';
import { BrandService } from './brand.service';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><html><body>x</body></html>');

describe('brand checks', () => {
  it('accepts PNG, JPEG and WebP by their first bytes', () => {
    expect(logoType(PNG)).toBe('image/png');
    expect(logoType(JPEG)).toBe('image/jpeg');
    expect(logoType(WEBP)).toBe('image/webp');
    expect(logoType(Buffer.alloc(0))).toBeNull();
  });

  it('refuses an SVG renamed .png and HTML with a PNG name', () => {
    expect(logoType(SVG)).toBeNull();
    expect(logoType(HTML)).toBeNull();
    // A name or a content type says nothing: only the bytes count. A truncated header is not a PNG either.
    expect(logoType(PNG.subarray(0, 4))).toBeNull();
    expect(logoType(Buffer.from('<html><!-- \x89PNG --></html>'))).toBeNull();
    expect(logoType(Buffer.from('RIFF....WEB'))).toBeNull();
  });

  it('refuses #FFFF00 and accepts #1A56DB', () => {
    expect(isUsableColor('#FFFF00')).toBe(false);
    expect(isUsableColor('#1A56DB')).toBe(true);
    expect(isUsableColor('#fff')).toBe(false);
    expect(isUsableColor('1A56DB')).toBe(false);
    expect(contrastWithWhite('#000000')).toBeCloseTo(21, 0);
    expect(contrastWithWhite('#FFFFFF')).toBeCloseTo(1, 5);
  });
});

let t: TestContext;
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const controller = () => new BrandController(t.db, new BrandService(t.db, get(AuditService)));
const b64 = (b: Buffer) => ({ data_base64: b.toString('base64') });

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(async () => { await t.reset(); });

async function newClient(name: string) {
  return t.db.insertInto('client').values({ name }).returning('id').executeTakeFirstOrThrow();
}
async function clientPerson(clientId: string, roleName: string) {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  const m = await t.db.insertInto('client_membership').values({ administrator_id: a.id, client_id: clientId, status: 'active', accepted_at: new Date() }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return a;
}
async function requestOf(admin: { id: string; email: string }, clientId: string): Promise<ConsoleRequest> {
  return {
    principal: { sessionId: '00000000-0000-0000-0000-00000000005e', administratorId: admin.id, name: 'Test', email: admin.email, language: 'en', timezone: 'UTC', secondFactorComplete: true, kind: 'client', activeClientId: clientId },
    auth: await new AuthorisationService(t.db).load(admin.id, clientId),
    clientAddress: '127.0.0.1', clientDescription: 'vitest',
  } as unknown as ConsoleRequest;
}
async function acme() {
  const client = await newClient('Acme');
  const project = await t.db.insertInto('project').values({ code: 'acme-shop', name: 'Shop', client_id: client.id }).returning('id').executeTakeFirstOrThrow();
  return { client, project };
}

describe('project brand', () => {
  it('starts on ProxiaPay\'s primary with no logo', async () => {
    const { client, project } = await acme();
    const owner = await clientPerson(client.id, 'Client owner');
    expect(await controller().get(project.id, await requestOf(owner, client.id))).toEqual({ logo_asset_id: null, primary_color: '#0B0D12', secondary_color: null });
  });

  it('a client owner sets colours and logo, and each change is audited', async () => {
    const { client, project } = await acme();
    const owner = await clientPerson(client.id, 'Client owner');
    const req = await requestOf(owner, client.id);
    await controller().setColors(project.id, { primary_color: '#1A56DB', secondary_color: '#0E7490' }, req);
    const { asset_id } = await controller().setLogo(project.id, b64(PNG), req);
    expect(await controller().get(project.id, req)).toEqual({ logo_asset_id: asset_id, primary_color: '#1A56DB', secondary_color: '#0E7490' });
    // A second colour change keeps the logo; the secondary colour can be cleared.
    await controller().setColors(project.id, { primary_color: '#1A56DB' }, req);
    expect(await controller().get(project.id, req)).toEqual({ logo_asset_id: asset_id, primary_color: '#1A56DB', secondary_color: null });
    const asset = await t.db.selectFrom('brand_asset').selectAll().executeTakeFirstOrThrow();
    expect(asset).toMatchObject({ project_id: project.id, content_type: 'image/png' });
    const actions = (await t.db.selectFrom('audit_record').select('action').where('subject_id', '=', project.id).orderBy('id').execute()).map((r) => r.action);
    expect(actions).toEqual(['brand.colors', 'brand.logo', 'brand.colors']);
  });

  it('a logo first, then colours, still gets a row', async () => {
    const { client, project } = await acme();
    const owner = await clientPerson(client.id, 'Client owner');
    const req = await requestOf(owner, client.id);
    const { asset_id } = await controller().setLogo(project.id, b64(WEBP), req);
    expect(await controller().get(project.id, req)).toEqual({ logo_asset_id: asset_id, primary_color: '#0B0D12', secondary_color: null });
  });

  it('refuses an SVG renamed .png with a 400 on logo', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    await expect(controller().setLogo(project.id, b64(SVG), req)).rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'Use a PNG, JPEG or WebP image of at most 200 KB.', options: { field: 'logo' } });
    await expect(controller().setLogo(project.id, b64(HTML), req)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await expect(controller().setLogo(project.id, b64(PNG.subarray(0, 4)), req)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await expect(controller().setLogo(project.id, {}, req)).rejects.toMatchObject({ code: 'FIELD_INVALID', options: { field: 'logo' } });
  });

  it('refuses a 201 KB PNG and accepts one at the limit', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    const sized = (n: number) => Buffer.concat([PNG, Buffer.alloc(n - PNG.length)]);
    await expect(controller().setLogo(project.id, b64(sized(201 * 1024)), req)).rejects.toMatchObject({ code: 'FIELD_INVALID', options: { field: 'logo' } });
    await controller().setLogo(project.id, b64(sized(MAX_LOGO_BYTES)), req);
    expect(await t.db.selectFrom('brand_asset').select('id').execute()).toHaveLength(1);
  });

  it('refuses a colour too light for white text, naming the field', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    await expect(controller().setColors(project.id, { primary_color: '#FFFF00' }, req)).rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'This colour is too light for white text; pick a darker one.', options: { field: 'primary_color' } });
    await expect(controller().setColors(project.id, { primary_color: '#1A56DB', secondary_color: '#FFFF00' }, req)).rejects.toMatchObject({ options: { field: 'secondary_color' } });
    // A malformed value is told how to write one, not that it is too light.
    for (const bad of ['#fff', 'blue', '1A56DB', '#GGGGGG']) {
      await expect(controller().setColors(project.id, { primary_color: bad }, req)).rejects.toMatchObject({ message: 'Use a colour written like #1A56DB.', options: { field: 'primary_color' } });
    }
    await expect(controller().setColors(project.id, { primary_color: '#1A56DB', secondary_color: 'blue' }, req)).rejects.toMatchObject({ message: 'Use a colour written like #1A56DB.', options: { field: 'secondary_color' } });
    expect(await t.db.selectFrom('project_brand').select('project_id').execute()).toEqual([]);
  });

  it('a client developer cannot change the brand, but can read it', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client developer'), client.id);
    await expect(controller().setColors(project.id, { primary_color: '#1A56DB' }, req)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(controller().setLogo(project.id, b64(PNG), req)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await controller().get(project.id, req)).toMatchObject({ primary_color: '#0B0D12' });
  });

  it('a client owner sets the brand of their own project only', async () => {
    const { client } = await acme();
    const other = await newClient('Other');
    const theirs = await t.db.insertInto('project').values({ code: 'other-shop', name: 'Theirs', client_id: other.id }).returning('id').executeTakeFirstOrThrow();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    await expect(controller().setColors(theirs.id, { primary_color: '#1A56DB' }, req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(controller().setLogo(theirs.id, b64(PNG), req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(controller().get(theirs.id, req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
