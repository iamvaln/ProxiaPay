import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadEnv } from './cli/env';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';
import { rootLogger } from './logging/logger';
import { DB_TOKEN, type Db } from './db/database';

async function bootstrap() {
  loadEnv();
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ['error', 'warn'], abortOnError: false, bodyParser: true });
  app.set('trust proxy', false); // addresses are derived explicitly; see http/client-address.ts
  app.disable('x-powered-by');
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    next();
  });
  app.enableCors({ origin: config.CONSOLE_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Requested-With', 'If-None-Match'] });
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  rootLogger.info({ port: config.PORT, environment: config.PROXIAPAY_ENV }, 'api listening');
  const shutdown = async () => {
    await app.close();
    await app.get<Db>(DB_TOKEN).destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
bootstrap().catch((e) => { rootLogger.fatal({ err: e }, 'failed to start'); process.exit(1); });
