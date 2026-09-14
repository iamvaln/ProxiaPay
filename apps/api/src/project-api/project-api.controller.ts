import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CryptoService } from '../crypto/crypto.service';
import { CONFIG, type AppConfig } from '../config/config';
import { DB_TOKEN, type Db } from '../db/database';
import { clientAddress } from '../http/client-address';
import { nonEmpty, parseBody } from '../http/validation';
import { LedgerService } from '../ledger/ledger.service';
import { ProjectAuthService } from '../project-auth/project-auth.service';
import { PreviewService } from '../transactions/preview.service';
import { TransactionReader } from '../transactions/transaction-reader';
import { TransactionService } from '../transactions/transaction.service';
import { RouteResolver } from '../routes/route-resolver';
import { ProviderAccountService } from '../providers/provider-account.service';
import { PlatformError } from '../common/errors';
import { SubmissionService } from '../providers/submission.service';
import { ProjectAuthGuard, type ProjectRequest } from './project-auth.guard';
import { listTransactions, listQuerySchema } from './transaction-list';

const tokenSchema = z.object({ client_key: nonEmpty(128), client_secret: nonEmpty(256) });
const confirmSchema = z.object({ preview_reference: nonEmpty(64) });
const codeSchema = z.object({ code: z.string().regex(/^\d{4,8}$/, 'must be 4 to 8 digits') });

/** The project interface of API reference sections 3 and 5. */
@Controller('v1')
export class ProjectApiController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'TRUSTED_PROXY_HOPS'>,
    private readonly auth: ProjectAuthService,
    private readonly previews: PreviewService,
    private readonly transactions: TransactionService,
    private readonly reader: TransactionReader,
    private readonly resolver: RouteResolver,
    private readonly ledger: LedgerService,
    private readonly accounts: ProviderAccountService,
    private readonly submission: SubmissionService,
  ) {}

  @Post('auth/tokens')
  @HttpCode(200)
  async tokens(@Body() body: unknown, @Req() req: Request) {
    const { client_key, client_secret } = parseBody(tokenSchema, body);
    return this.auth.exchange(client_key, client_secret, clientAddress(req, this.config.TRUSTED_PROXY_HOPS));
  }

  @Post('previews')
  @HttpCode(201)
  @UseGuards(ProjectAuthGuard)
  async preview(@Body() body: unknown, @Req() req: ProjectRequest) {
    return this.previews.create(req.principal, body);
  }

  @Post('collections')
  @UseGuards(ProjectAuthGuard)
  async collections(@Body() body: unknown, @Req() req: ProjectRequest, @Res({ passthrough: true }) res: Response) {
    return this.confirm(body, req, res, 'collection');
  }

  @Post('disbursements')
  @UseGuards(ProjectAuthGuard)
  async disbursements(@Body() body: unknown, @Req() req: ProjectRequest, @Res({ passthrough: true }) res: Response) {
    return this.confirm(body, req, res, 'disbursement');
  }

  private async confirm(body: unknown, req: ProjectRequest, res: Response, direction: 'collection' | 'disbursement') {
    const { preview_reference } = parseBody(confirmSchema, body);
    const { transactionId, created } = await this.transactions.confirm(req.principal, preview_reference, direction);
    if (created) await this.submission.submit(transactionId);
    res.status(created ? 201 : 200);
    return this.reader.apiById(this.db, transactionId, { revealMsisdn: true, revealAction: true });
  }

  @Post('transactions/:reference/code')
  @HttpCode(200)
  @UseGuards(ProjectAuthGuard)
  async code(@Param('reference') reference: string, @Body() body: unknown, @Req() req: ProjectRequest) {
    const { code } = parseBody(codeSchema, body);
    return this.transactions.submitCode(req.principal, reference, code, async (txn, providerReference, c) => {
      const attempt = await this.db.selectFrom('transaction_attempt').select(['provider_account_id']).where('id', '=', txn.current_attempt_id!).executeTakeFirstOrThrow();
      const { ctx, adapterKey } = await this.accounts.context(this.db, attempt.provider_account_id, txn.correlation_id, txn.id);
      const adapter = this.accounts.adapter(adapterKey);
      if (!adapter.submitCode) throw new PlatformError('ACTION_NOT_AVAILABLE', 'This route does not accept a code through the platform.');
      const r = await adapter.submitCode(ctx, providerReference, c);
      return { state: r.state, actualProviderFee: r.providerFee ?? null, operatorReference: r.operatorReference ?? null, failureReason: r.failureReason, payloadId: r.payloadId };
    });
  }

  @Get('transactions/:reference')
  @UseGuards(ProjectAuthGuard)
  async transaction(@Param('reference') reference: string, @Req() req: ProjectRequest) {
    return this.transactions.apiByReference(req.principal, reference);
  }

  @Get('transactions')
  @UseGuards(ProjectAuthGuard)
  async list(@Query() query: Record<string, string | string[]>, @Req() req: ProjectRequest) {
    const q = parseBody(listQuerySchema, normaliseQuery(query));
    return listTransactions(this.db, this.reader, req.principal.projectId, q);
  }

  @Get('settings')
  @UseGuards(ProjectAuthGuard)
  async settings(@Req() req: ProjectRequest, @Res({ passthrough: true }) res: Response, @Headers('if-none-match') ifNoneMatch?: string) {
    const settings = await this.resolver.settingsForProject(req.principal.projectId);
    const fingerprint = `cfg_${CryptoService.sha256Hex(JSON.stringify(settings)).slice(0, 12)}`;
    const etag = `"${fingerprint}"`;
    res.setHeader('ETag', etag);
    if (ifNoneMatch && ifNoneMatch.split(',').map((s) => s.trim()).includes(etag)) {
      res.status(304);
      return;
    }
    return { fingerprint, ...settings };
  }

  @Get('balances')
  @UseGuards(ProjectAuthGuard)
  async balances(@Req() req: ProjectRequest) {
    const balances = await this.ledger.projectBalances(this.db, req.principal.projectId);
    return { balances };
  }
}

function normaliseQuery(q: Record<string, string | string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (k === 'state') out[k] = Array.isArray(v) ? v : [v];
    else if (k === 'limit') out[k] = Number(v);
    else out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}
