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
import { HomeService } from './home.service';
import { ClientProjectsService } from './client-projects.service';
import { TeamController } from './team.controller';
import { InvitationController } from './invitation.controller';
import { ClientsModule } from '../clients/clients.module';
import { ClientsController } from './clients.controller';
import { PaymentLinksModule } from '../payment-links/payment-links.module';
import { BrandController } from './brand.controller';

/** The console's server side: a separate interface project credentials never reach (spec 7). */
@Module({
  imports: [ClientsModule, PaymentLinksModule],
  controllers: [ConsoleAuthController, HomeController, ConsoleTransactionsController, ConsoleProjectsController, ConfigurationController, TreasuryController, ReconciliationController, OversightController, TeamController, InvitationController, ClientsController, BrandController],
  providers: [SessionGuard, ApprovalService, RoleService, EntitlementService, RouteService, ExportService, HomeService, ClientProjectsService],
})
export class ConsoleApiModule {}
