import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Header, Inject, Module } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/config';
import { buildOpenApi } from './openapi';

/**
 * The integration guide and the interface specification, served by the API itself (spec 7.5).
 * Both are derived at start from what this process validates with, so what a product reads at
 * /docs is the interface of the version answering it — there is no publication step to forget.
 * The reference renderer is served from this process too: a payment host loads no third-party script.
 */
@Controller('docs')
export class DocsController {
  private readonly page: string;
  private readonly spec: string;
  private readonly renderer: string;

  constructor(@Inject(CONFIG) config: Pick<AppConfig, 'PROXIAPAY_ENV'>) {
    const doc = buildOpenApi(config.PROXIAPAY_ENV);
    this.spec = JSON.stringify(doc);
    const template = readFileSync(join(__dirname, '..', '..', 'assets', 'docs.html'), 'utf8');
    this.page = template
      .replaceAll('{{ENV}}', config.PROXIAPAY_ENV)
      .replaceAll('{{SERVER}}', doc.servers[0]?.url ?? '')
      .replaceAll('{{VERSION}}', doc.info.version);
    this.renderer = readFileSync(require.resolve('redoc/bundles/redoc.standalone.js'), 'utf8');
  }

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'public, max-age=300')
  guide(): string {
    return this.page;
  }

  @Get('openapi.json')
  @Header('content-type', 'application/json; charset=utf-8')
  @Header('cache-control', 'public, max-age=300')
  openapi(): string {
    return this.spec;
  }

  @Get('redoc.standalone.js')
  @Header('content-type', 'application/javascript; charset=utf-8')
  @Header('cache-control', 'public, max-age=86400')
  redoc(): string {
    return this.renderer;
  }
}

@Module({ controllers: [DocsController] })
export class DocsModule {}
