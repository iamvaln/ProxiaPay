import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PlatformError } from '../common/errors';
import { CONFIG, type AppConfig } from '../config/config';
import { clientAddress } from '../http/client-address';
import { requestContext } from '../logging/logger';
import { ProjectAuthService, type ProjectPrincipal } from '../project-auth/project-auth.service';

export interface ProjectRequest extends Request { principal: ProjectPrincipal; clientAddress: string }

/** Origin first, then the bearer token, then the per-credential rate limit whose state every response carries (API reference 2.7, 3). */
@Injectable()
export class ProjectAuthGuard implements CanActivate {
  constructor(private readonly auth: ProjectAuthService, @Inject(CONFIG) private readonly config: Pick<AppConfig, 'TRUSTED_PROXY_HOPS'>) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ProjectRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const address = clientAddress(req, this.config.TRUSTED_PROXY_HOPS);
    req.clientAddress = address;
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new PlatformError('TOKEN_INVALID', 'A bearer token is required.');
    const principal = await this.auth.resolveToken(token.trim(), address);
    req.principal = principal;
    const store = requestContext.getStore();
    if (store) store.projectId = principal.projectId;
    const rl = await this.auth.requestRateLimit(principal);
    res.setHeader('X-RateLimit-Limit', String(rl.limit));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(rl.resetAt.getTime() / 1000)));
    if (rl.exceeded) throw new PlatformError('RATE_LIMITED', 'The credential exceeded its request rate.', { headers: { 'Retry-After': String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } });
    return true;
  }
}
