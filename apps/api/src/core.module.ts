import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './config/config';
import { createDb, createPool, DB_TOKEN } from './db/database';
import { CryptoService } from './crypto/crypto.service';
import { LedgerService } from './ledger/ledger.service';
import { SettingsService } from './settings/settings.service';
import { AuditService } from './audit/audit.service';
import { JobQueue } from './jobs/job-queue';
import { Worker } from './jobs/worker';
import { AdminAuthService } from './admin-auth/admin-auth.service';
import { AuthorisationService } from './admin-auth/authorisation.service';
import { ConfirmationService } from './admin-auth/confirmation.service';
import { ProjectAuthService } from './project-auth/project-auth.service';
import { CredentialService } from './project-auth/credential.service';
import { RateLimiter } from './project-auth/rate-limiter';
import { RouteResolver } from './routes/route-resolver';
import { PreviewService } from './transactions/preview.service';
import { TransactionService } from './transactions/transaction.service';
import { TransactionReader } from './transactions/transaction-reader';
import { ProviderRegistry } from './providers/provider-registry';
import { ProviderAccountService } from './providers/provider-account.service';
import { CircuitBreaker } from './providers/circuit-breaker';
import { SubmissionService } from './providers/submission.service';
import { StatusService } from './providers/status.service';
import { NotificationService } from './notifications/notification.service';
import { AlertService } from './alerts/alert.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { StatementService } from './reconciliation/statement.service';
import { DiscrepancyService } from './reconciliation/discrepancy.service';
import { TreasuryService } from './treasury/treasury.service';
import { HealthService } from './alerts/health.service';
import { Mailer } from './alerts/mailer';

const config = { provide: CONFIG, useFactory: () => loadConfig() };
const db = {
  provide: DB_TOKEN,
  useFactory: () => {
    const cfg = loadConfig();
    return createDb(createPool(cfg.DATABASE_URL, cfg.NODE_ENV === 'test' ? 4 : 10));
  },
};

/** Every service the platform is built from, in one global module so controllers and workers share instances. */
@Global()
@Module({
  providers: [
    config, db, CryptoService, LedgerService, SettingsService, AuditService, JobQueue, Worker,
    AdminAuthService, AuthorisationService, ConfirmationService, ProjectAuthService, CredentialService, RateLimiter,
    RouteResolver, PreviewService, TransactionService, TransactionReader,
    ProviderRegistry, ProviderAccountService, CircuitBreaker, SubmissionService, StatusService,
    NotificationService, AlertService, Mailer, HealthService, ReconciliationService, StatementService, DiscrepancyService, TreasuryService,
  ],
  exports: [
    CONFIG, DB_TOKEN, CryptoService, LedgerService, SettingsService, AuditService, JobQueue, Worker,
    AdminAuthService, AuthorisationService, ConfirmationService, ProjectAuthService, CredentialService, RateLimiter,
    RouteResolver, PreviewService, TransactionService, TransactionReader,
    ProviderRegistry, ProviderAccountService, CircuitBreaker, SubmissionService, StatusService,
    NotificationService, AlertService, Mailer, HealthService, ReconciliationService, StatementService, DiscrepancyService, TreasuryService,
  ],
})
export class CoreModule {}
