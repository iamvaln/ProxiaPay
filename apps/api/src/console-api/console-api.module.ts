import { Module } from '@nestjs/common';
import { ConsoleAuthController } from './auth.controller';
import { HomeController } from './home.controller';
import { ConsoleTransactionsController } from './transactions.controller';
import { ConsoleProjectsController } from './projects.controller';
import { ConfigurationController } from './configuration.controller';
import { TreasuryController } from './treasury.controller';
import { ReconciliationController } from './reconciliation.controller';
import { OversightController } from './oversight.controller';
import { SessionGuard } from './session.guard';
import { ApprovalService } from './approval.service';
import { RoleService } from './role.service';
import { EntitlementService } from './entitlement.service';
import { RouteService } from './route.service';
import { ExportService } from './export.service';

/** The console's server side: a separate interface project credentials never reach (spec 7). */
@Module({
  controllers: [ConsoleAuthController, HomeController, ConsoleTransactionsController, ConsoleProjectsController, ConfigurationController, TreasuryController, ReconciliationController, OversightController],
  providers: [SessionGuard, ApprovalService, RoleService, EntitlementService, RouteService, ExportService],
})
export class ConsoleApiModule {}
