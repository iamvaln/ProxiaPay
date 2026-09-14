import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { parse as parseCookie } from 'cookie';
import { PlatformError } from '../common/errors';
import { CONFIG, type AppConfig } from '../config/config';
import { clientAddress } from '../http/client-address';
import { requestContext } from '../logging/logger';
import { AdminAuthService, type SessionPrincipal } from '../admin-auth/admin-auth.service';
import { AuthorisationService, type Authorisation } from '../admin-auth/authorisation.service';
import type { Permission } from '../permissions/permissions';

export const SESSION_COOKIE = 'pp_session';
export const ALLOW_PARTIAL = 'allowPartialSession';
export const PERMISSION_KEY = 'requiredPermission';

/** Marks an endpoint reachable before the second factor completes (the second-factor endpoints themselves). */
export const AllowPartialSession = () => SetMetadata(ALLOW_PARTIAL, true);
/** Declares the permission an endpoint requires; scope is applied by the handler with `req.auth`. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

export interface ConsoleRequest extends Request {
  principal: SessionPrincipal;
  auth: Authorisation;
  clientAddress: string;
  clientDescription: string;
}

/**
 * Console sessions: an HttpOnly, SameSite=Strict cookie holding an opaque token resolved in the
 * store, a custom header on every mutating call as the cross-site guard, and the permission the
 * endpoint declares checked before the handler runs. Permission denied names the permission.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: AdminAuthService,
    private readonly authorisation: AuthorisationService,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'TRUSTED_PROXY_HOPS'>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ConsoleRequest>();
    req.clientAddress = clientAddress(req, this.config.TRUSTED_PROXY_HOPS);
    req.clientDescription = String(req.headers['user-agent'] ?? '').slice(0, 256);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'ProxiaPay') {
      throw new PlatformError('PERMISSION_DENIED', 'Mutating console calls carry the X-Requested-With header.');
    }
    const token = parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE];
    const principal = token ? await this.sessions.resolveSession(token) : undefined;
    if (!principal) throw new PlatformError('UNAUTHENTICATED', 'Sign in to continue.');
    const partialAllowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PARTIAL, [ctx.getHandler(), ctx.getClass()]);
    if (!principal.secondFactorComplete && !partialAllowed) throw new PlatformError('SECOND_FACTOR_REQUIRED', 'Complete the second factor to continue.');
    req.principal = principal;
    const store = requestContext.getStore();
    if (store) store.administratorId = principal.administratorId;
    req.auth = await this.authorisation.load(principal.administratorId);
    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (required) req.auth.require(required);
    return true;
  }
}

export function setSessionCookie(res: Response, token: string, secure: boolean, maxAgeSeconds: number): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/console; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/console; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
}
