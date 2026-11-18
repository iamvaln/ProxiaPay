import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { CONFIG, type AppConfig } from '../config/config';
import { DB_TOKEN, type Db } from '../db/database';
import { clientAddress } from '../http/client-address';
import { nonEmpty, parseBody } from '../http/validation';
import { SettingsService } from '../settings/settings.service';
import { AllowPartialSession, clearSessionCookie, SessionGuard, setSessionCookie, type ConsoleRequest } from './session.guard';
import { ClientAccessible } from './client-access';
import { PERMISSIONS } from '../permissions/permissions';

const signInSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256), language: z.enum(['en', 'fr']).optional() });
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const passwordSchema = z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(12).max(256) });
const preferencesSchema = z.object({ language: z.enum(['en', 'fr']).optional(), timezone: z.string().max(64).optional() });
// null is the super-admin view: present, never just missing, so a malformed body is not read as a switch back.
const activeClientSchema = z.object({ client_id: z.string().uuid().nullable() });
const confirmationRequestSchema = z.object({ operation_type: nonEmpty(64), values: z.unknown(), subject_reference: z.string().max(128).optional() });

/** Sign-in with a second factor (console spec 4.1), session management, and one-time code requests. */
@Controller('console/auth')
export class ConsoleAuthController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'TRUSTED_PROXY_HOPS' | 'NODE_ENV' | 'PROXIAPAY_ENV'>,
    private readonly auth: AdminAuthService,
    private readonly settings: SettingsService,
    private readonly confirmations: ConfirmationService,
  ) {}

  private get secure() {
    return this.config.NODE_ENV === 'production';
  }

  /** Which environment this is, before any session: the sign-in page shows it too (console spec 2). */
  @Get('environment')
  environment() {
    return { environment: this.config.PROXIAPAY_ENV };
  }

  @Post('sign-in')
  @HttpCode(200)
  async signIn(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password, language } = parseBody(signInSchema, body);
    const client = { address: clientAddress(req, this.config.TRUSTED_PROXY_HOPS), description: String(req.headers['user-agent'] ?? '') };
    const result = await this.auth.signIn(email, password, client);
    if ('locked_until' in result) return { locked: true, locked_until: result.locked_until.toISOString() };
    if (language) await this.db.updateTable('administrator').set({ language }).where('email', '=', email.trim().toLowerCase()).execute();
    setSessionCookie(res, result.sessionToken, this.secure, await this.settings.number('session.absolute_seconds'));
    return { second_factor: result.secondFactor };
  }

  @Post('second-factor/enrol')
  @ClientAccessible()
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @AllowPartialSession()
  async enrol(@Req() req: ConsoleRequest) {
    return this.auth.beginTotpEnrolment(req.principal);
  }

  @Post('second-factor')
  @ClientAccessible()
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @AllowPartialSession()
  async secondFactor(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { code } = parseBody(codeSchema, body);
    await this.auth.completeSecondFactor(req.principal, code, { address: req.clientAddress, description: req.clientDescription });
    return { ok: true };
  }

  @Post('sign-out')
  @ClientAccessible()
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @AllowPartialSession()
  async signOut(@Req() req: ConsoleRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.revokeSession(req.principal.sessionId, req.principal.administratorId);
    clearSessionCookie(res, this.secure);
    return { ok: true };
  }

  @Get('me')
  @ClientAccessible()
  @UseGuards(SessionGuard)
  @AllowPartialSession()
  async me(@Req() req: ConsoleRequest) {
    const p = req.principal;
    // Either kind of account may belong to partners: a platform account switches between them and the super-admin view.
    const memberships = await this.auth.activeMemberships(p.administratorId);
    return {
      administrator: { id: p.administratorId, name: p.name, email: p.email, language: p.language, timezone: p.timezone },
      kind: p.kind,
      account_kind: p.accountKind,
      active_client: p.kind === 'client' ? (memberships.filter((m) => m.client_id === p.activeClientId).map((m) => ({ id: m.client_id, name: m.name }))[0] ?? null) : null,
      clients: memberships.map((m) => ({ id: m.client_id, name: m.name })),
      // Offered for acceptance by POST memberships/:mid/accept; none of them is a client to switch to yet. A platform account is never invited.
      pending_clients: p.accountKind === 'client' ? await this.auth.pendingMemberships(p.administratorId) : [],
      second_factor_complete: p.secondFactorComplete,
      permissions: p.secondFactorComplete ? req.auth.permissions() : [],
      environment: this.config.PROXIAPAY_ENV,
      permission_catalogue: PERMISSIONS,
    };
  }

  /** Reachable from a partner's view, since it is the only way back to the super-admin view. */
  @Post('active-client')
  @ClientAccessible()
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async switchClient(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { client_id } = parseBody(activeClientSchema, body);
    await this.auth.switchClient(req.principal, client_id);
    return { ok: true };
  }

  @Patch('preferences')
  @ClientAccessible()
  @UseGuards(SessionGuard)
  async preferences(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const prefs = parseBody(preferencesSchema, body);
    await this.db.updateTable('administrator').set({ ...(prefs.language ? { language: prefs.language } : {}), ...(prefs.timezone ? { timezone: prefs.timezone } : {}) }).where('id', '=', req.principal.administratorId).execute();
    return { ok: true };
  }

  @Post('password')
  @ClientAccessible()
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async password(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { current_password, new_password } = parseBody(passwordSchema, body);
    await this.auth.changePassword(req.principal.administratorId, current_password, new_password);
    return { ok: true };
  }

  @Get('sessions')
  @ClientAccessible()
  @UseGuards(SessionGuard)
  async sessions(@Req() req: ConsoleRequest) {
    return { sessions: await this.auth.listSessions(req.principal.administratorId), current: req.principal.sessionId };
  }

  /** Requests a one-time code for an operation and the exact values about to be submitted (console spec 11.1). */
  @Post('confirmations')
  @ClientAccessible()
  @HttpCode(201)
  @UseGuards(SessionGuard)
  async requestConfirmation(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { operation_type, values, subject_reference } = parseBody(confirmationRequestSchema, body);
    const r = await this.confirmations.request(req.principal.administratorId, req.principal.email, req.principal.language, operation_type, values, subject_reference);
    return { confirmation_id: r.confirmationId, expires_at: r.expiresAt.toISOString() };
  }
}
