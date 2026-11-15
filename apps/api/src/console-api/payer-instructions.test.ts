import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestContext, type TestContext } from '../test/context';
import { consoleRequest } from '../test/console-request';
import { AuditService } from '../audit/audit.service';
import { ConfigurationController } from './configuration.controller';

let t: TestContext;
let controller: ConfigurationController;

beforeAll(async () => {
  t = await createTestContext();
  controller = new ConfigurationController(t.db, t.app.get(AuditService), null as never, null as never, null as never, null as never);
});
afterAll(() => t.close());
beforeEach(() => t.reset());

// The audit record points at a real administrator.
async function admin() {
  const adminId = (await t.admin()).id;
  const req = consoleRequest(t);
  req.principal = { ...req.principal, administratorId: adminId };
  return req;
}
const momo = async () => (await t.db.selectFrom('route').select('id').where('country_code', '=', 'CM').where('payment_method_code', '=', 'MOMO').where('direction', '=', 'collection').executeTakeFirstOrThrow()).id;

describe('PUT /console/configuration/routes/:id/payer-instructions', () => {
  it('sets the text through the real trigger and audits it', async () => {
    const id = await momo();
    const res = await controller.setPayerInstructions(id, { en: ' Approve with your PIN. ', fr: 'Validez avec votre code.' }, await admin());
    expect(res.payer_instructions).toEqual({ en: 'Approve with your PIN.', fr: 'Validez avec votre code.' });
    const row = await t.db.selectFrom('route').select('payer_instructions').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.payer_instructions).toEqual({ en: 'Approve with your PIN.', fr: 'Validez avec votre code.' });
    const audit = await t.db.selectFrom('audit_record').select(['subject_id']).where('action', '=', 'route.payer_instructions').execute();
    expect(audit.map((a) => a.subject_id)).toEqual([id]);
  });

  it('stores null when both texts are empty, and refuses over 500 characters', async () => {
    const id = await momo();
    await controller.setPayerInstructions(id, { en: 'x', fr: '' }, await admin());
    const cleared = await controller.setPayerInstructions(id, { en: '', fr: ' ' }, await admin());
    expect(cleared.payer_instructions).toBeNull();
    await expect(controller.setPayerInstructions(id, { en: 'x'.repeat(501), fr: '' }, await admin())).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await expect(controller.setPayerInstructions('00000000-0000-0000-0000-0000000000aa', { en: 'a', fr: '' }, await admin())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps the route otherwise immutable', async () => {
    const id = await momo();
    await expect(sql`update route set country_code = 'CI' where id = ${id}`.execute(t.db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from route where id = ${id}`.execute(t.db)).rejects.toThrow(/append-only/);
  });

  it('is not reachable without routes.open_version', () => {
    expect(() => consoleRequest(t, { permissions: ['routes.read'] }).auth.require('routes.open_version')).toThrow();
  });
});
