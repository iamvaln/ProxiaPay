import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CoreModule } from './core.module';
import { PlatformExceptionFilter } from './http/exception.filter';
import { requestContextMiddleware } from './http/request-context.middleware';
import { ProjectApiModule } from './project-api/project-api.module';
import { ConsoleApiModule } from './console-api/console-api.module';
import { ProviderWebhookModule } from './providers/provider-webhook.module';
import { DocsModule } from './docs/docs.module';
import { HealthzModule } from './health/healthz.module';

@Module({
  imports: [CoreModule, ProjectApiModule, ConsoleApiModule, ProviderWebhookModule, DocsModule, HealthzModule],
  providers: [{ provide: APP_FILTER, useClass: PlatformExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes('*');
  }
}
