import { Controller, Get, Module } from '@nestjs/common';

/**
 * Liveness, for the container probe and nothing else. It takes no dependencies on purpose:
 * a probe that read the database would report the process dead during a database outage, and
 * Compose would restart a process that was answering perfectly well. Readiness — can this
 * instance actually serve traffic — is a different question, and the console's own screens
 * (spec 8.5) answer it with far more than a boolean.
 */
@Controller('healthz')
export class HealthzController {
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthzController] })
export class HealthzModule {}
