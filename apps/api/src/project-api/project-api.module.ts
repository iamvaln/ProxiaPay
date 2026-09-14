import { Module } from '@nestjs/common';
import { ProjectApiController } from './project-api.controller';
import { ProjectAuthGuard } from './project-auth.guard';

@Module({ controllers: [ProjectApiController], providers: [ProjectAuthGuard] })
export class ProjectApiModule {}
