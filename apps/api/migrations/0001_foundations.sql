-- ProxiaPay schema, stage 1–4 (foundations, collections, reconciliation, disbursements).
-- Conventions: monetary columns are BIGINT minor units and always sit beside a currency column;
-- rates are integers in basis points (hundredths of a percent); timestamps are timestamptz in UTC;
-- append-only tables refuse UPDATE and DELETE through triggers, and the deployment additionally
-- revokes those privileges from the application role (see docs/operations.md).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- reference data

CREATE TABLE country (
  code            char(2) PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  iso3            char(3) NOT NULL UNIQUE CHECK (iso3 ~ '^[A-Z]{3}$'),
  name            text NOT NULL,
  dialling_prefix text NOT NULL CHECK (dialling_prefix ~ '^\+[0-9]{1,4}$'),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE currency (
  code       char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name       text NOT NULL,
  exponent   smallint NOT NULL CHECK (exponent BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE country_currency (
  country_code  char(2) NOT NULL REFERENCES country(code),
  currency_code char(3) NOT NULL REFERENCES currency(code),
  PRIMARY KEY (country_code, currency_code)
);

CREATE TABLE payment_method (
  code       text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,16}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exchange_rate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency  char(3) NOT NULL REFERENCES currency(code),
  quote_currency char(3) NOT NULL REFERENCES currency(code),
  rate           numeric(20, 10) NOT NULL CHECK (rate > 0),
  effective_date date NOT NULL,
  source         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_currency, quote_currency, effective_date)
);

-- ---------------------------------------------------------------- administration

CREATE TABLE administrator (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  email                  citext NOT NULL UNIQUE,
  password_hash          text NOT NULL,
  totp_secret_ciphertext bytea,
  totp_enrolled_at       timestamptz,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  language               text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'fr')),
  timezone               text NOT NULL DEFAULT 'UTC',
  locked_until           timestamptz,
  last_sign_in_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER administrator_touch BEFORE UPDATE ON administrator FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE admin_session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_id   uuid NOT NULL REFERENCES administrator(id),
  token_hash         bytea NOT NULL UNIQUE,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  second_factor_at   timestamptz,
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES administrator(id),
  origin_address     inet NOT NULL,
  client_description text NOT NULL DEFAULT ''
);
CREATE INDEX admin_session_admin_idx ON admin_session (administrator_id) WHERE revoked_at IS NULL;

CREATE TABLE authentication_event (
  id                 bigserial PRIMARY KEY,
  email_presented    citext NOT NULL,
  administrator_id   uuid REFERENCES administrator(id),
  outcome            text NOT NULL CHECK (outcome IN ('success', 'failure', 'locked', 'second_factor_failure')),
  reason             text NOT NULL DEFAULT '',
  origin_address     inet NOT NULL,
  client_description text NOT NULL DEFAULT '',
  occurred_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authentication_event_email_idx ON authentication_event (email_presented, occurred_at DESC);
CREATE TRIGGER authentication_event_append_only BEFORE UPDATE OR DELETE ON authentication_event FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  seeded      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permission (
  role_id        uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

-- ---------------------------------------------------------------- providers

CREATE TABLE provider (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{2,32}$'),
  name        text NOT NULL,
  adapter_key text NOT NULL
);

CREATE TABLE provider_account (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code         text NOT NULL REFERENCES provider(code),
  name                  text NOT NULL,
  credential_ciphertext bytea,
  base_url              text NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'suspended')),
  supports_transfers    boolean NOT NULL DEFAULT false,
  supports_listing      boolean NOT NULL DEFAULT false,
  has_test_environment  boolean NOT NULL DEFAULT false,
  statement_format      text,
  webhook_secret_ciphertext bytea,
  suspended_at          timestamptz,
  suspended_by          uuid REFERENCES administrator(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_code, name)
);
CREATE TRIGGER provider_account_touch BEFORE UPDATE ON provider_account FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE provider_account_capability (
  provider_account_id uuid NOT NULL REFERENCES provider_account(id) ON DELETE CASCADE,
  country_code        char(2) NOT NULL REFERENCES country(code),
  currency_code       char(3) NOT NULL REFERENCES currency(code),
  payment_method_code text NOT NULL REFERENCES payment_method(code),
  direction           text NOT NULL CHECK (direction IN ('collection', 'disbursement')),
  PRIMARY KEY (provider_account_id, country_code, currency_code, payment_method_code, direction)
);

CREATE TABLE circuit_breaker (
  provider_account_id uuid PRIMARY KEY REFERENCES provider_account(id) ON DELETE CASCADE,
  state               text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count       integer NOT NULL DEFAULT 0,
  window_started_at   timestamptz,
  opened_at           timestamptz,
  last_probe_at       timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- routes and commercial terms

CREATE TABLE rate_change_set (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_at        timestamptz NOT NULL,
  note                text NOT NULL,
  agreement_reference text,
  created_by          uuid REFERENCES administrator(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE route (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code        char(2) NOT NULL REFERENCES country(code),
  currency_code       char(3) NOT NULL REFERENCES currency(code),
  payment_method_code text NOT NULL REFERENCES payment_method(code),
  direction           text NOT NULL CHECK (direction IN ('collection', 'disbursement')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_code, currency_code, payment_method_code, direction),
  FOREIGN KEY (country_code, currency_code) REFERENCES country_currency(country_code, currency_code)
);
CREATE TRIGGER route_immutable BEFORE UPDATE OR DELETE ON route FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE route_version (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id                  uuid NOT NULL REFERENCES route(id),
  sequence                  integer NOT NULL CHECK (sequence >= 1),
  processing_fee_bps        integer NOT NULL CHECK (processing_fee_bps >= 0),
  processing_fee_fixed      bigint NOT NULL DEFAULT 0 CHECK (processing_fee_fixed >= 0),
  processing_fee_floor      bigint CHECK (processing_fee_floor >= 0),
  processing_fee_ceiling    bigint CHECK (processing_fee_ceiling >= 0),
  platform_fee_bps          integer NOT NULL DEFAULT 0 CHECK (platform_fee_bps >= 0),
  platform_fee_fixed        bigint NOT NULL DEFAULT 0 CHECK (platform_fee_fixed >= 0),
  platform_fee_floor        bigint CHECK (platform_fee_floor >= 0),
  platform_fee_ceiling      bigint CHECK (platform_fee_ceiling >= 0),
  processing_fee_bearer     text NOT NULL DEFAULT 'counterparty' CHECK (processing_fee_bearer IN ('counterparty', 'project')),
  platform_fee_bearer       text NOT NULL DEFAULT 'counterparty' CHECK (platform_fee_bearer IN ('counterparty', 'project')),
  minimum_amount            bigint NOT NULL CHECK (minimum_amount >= 0),
  maximum_amount            bigint NOT NULL CHECK (maximum_amount >= minimum_amount),
  otp_required              boolean NOT NULL DEFAULT false,
  browser_required          boolean NOT NULL DEFAULT false,
  disbursement_fallback     boolean NOT NULL DEFAULT false,
  active                    boolean NOT NULL DEFAULT true,
  valid_from                timestamptz NOT NULL DEFAULT now(),
  valid_to                  timestamptz,
  created_by                uuid REFERENCES administrator(id),
  note                      text NOT NULL,
  fingerprint               text NOT NULL,
  rate_change_set_id        uuid REFERENCES rate_change_set(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, sequence),
  CHECK (NOT (otp_required AND browser_required)),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX route_version_one_open ON route_version (route_id) WHERE valid_to IS NULL;

-- A version may only ever be closed (valid_to set once); every other column is frozen.
CREATE OR REPLACE FUNCTION route_version_close_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'route version % is closed and immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF row(NEW.*) IS DISTINCT FROM row(OLD.*) AND (
       NEW.id, NEW.route_id, NEW.sequence, NEW.processing_fee_bps, NEW.processing_fee_fixed, NEW.processing_fee_floor,
       NEW.processing_fee_ceiling, NEW.platform_fee_bps, NEW.platform_fee_fixed, NEW.platform_fee_floor, NEW.platform_fee_ceiling,
       NEW.processing_fee_bearer, NEW.platform_fee_bearer, NEW.minimum_amount, NEW.maximum_amount, NEW.otp_required,
       NEW.browser_required, NEW.disbursement_fallback, NEW.active, NEW.valid_from, NEW.created_by, NEW.note, NEW.fingerprint,
       NEW.rate_change_set_id, NEW.created_at
     ) IS DISTINCT FROM (
       OLD.id, OLD.route_id, OLD.sequence, OLD.processing_fee_bps, OLD.processing_fee_fixed, OLD.processing_fee_floor,
       OLD.processing_fee_ceiling, OLD.platform_fee_bps, OLD.platform_fee_fixed, OLD.platform_fee_floor, OLD.platform_fee_ceiling,
       OLD.processing_fee_bearer, OLD.platform_fee_bearer, OLD.minimum_amount, OLD.maximum_amount, OLD.otp_required,
       OLD.browser_required, OLD.disbursement_fallback, OLD.active, OLD.valid_from, OLD.created_by, OLD.note, OLD.fingerprint,
       OLD.rate_change_set_id, OLD.created_at
     ) THEN
    RAISE EXCEPTION 'route version % is immutable; open a new version', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER route_version_close_only BEFORE UPDATE ON route_version FOR EACH ROW EXECUTE FUNCTION route_version_close_only();
CREATE TRIGGER route_version_no_delete BEFORE DELETE ON route_version FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE route_binding (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_version_id    uuid NOT NULL REFERENCES route_version(id),
  provider_account_id uuid NOT NULL REFERENCES provider_account(id),
  expected_fee_bps    integer NOT NULL CHECK (expected_fee_bps >= 0),
  expected_fee_fixed  bigint NOT NULL DEFAULT 0 CHECK (expected_fee_fixed >= 0),
  terms_status        text NOT NULL DEFAULT 'indicative' CHECK (terms_status IN ('indicative', 'contracted')),
  priority            integer NOT NULL CHECK (priority >= 1),
  enabled             boolean NOT NULL DEFAULT true,
  minimum_amount      bigint CHECK (minimum_amount >= 0),
  maximum_amount      bigint CHECK (maximum_amount >= 0),
  UNIQUE (route_version_id, priority),
  UNIQUE (route_version_id, provider_account_id)
);
CREATE TRIGGER route_binding_immutable BEFORE UPDATE OR DELETE ON route_binding FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- ---------------------------------------------------------------- projects and access

CREATE TABLE project (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_by uuid REFERENCES administrator(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER project_touch BEFORE UPDATE ON project FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE project_credential (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES project(id),
  key            text NOT NULL UNIQUE,
  secret_hash    text NOT NULL,
  scopes         text[] NOT NULL,
  role           text NOT NULL CHECK (role IN ('primary', 'secondary')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'deleted')),
  issued_by      uuid REFERENCES administrator(id),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES administrator(id),
  revoked_reason text,
  deleted_at     timestamptz,
  deleted_by     uuid REFERENCES administrator(id)
);
CREATE UNIQUE INDEX project_credential_one_per_role ON project_credential (project_id, role) WHERE status = 'active';

CREATE TABLE project_token (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id  uuid NOT NULL REFERENCES project_credential(id),
  token_hash     bytea NOT NULL UNIQUE,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  origin_address inet NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX project_token_credential_idx ON project_token (credential_id, issued_at DESC);

CREATE TABLE project_origin (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id),
  cidr        cidr NOT NULL,
  description text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES administrator(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_origin_project_idx ON project_origin (project_id) WHERE active;

CREATE TABLE origin_refusal (
  id             bigserial PRIMARY KEY,
  project_id     uuid REFERENCES project(id),
  credential_key text NOT NULL,
  origin_address inet NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX origin_refusal_project_idx ON origin_refusal (project_id, occurred_at DESC);

CREATE TABLE project_notification_endpoint (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL REFERENCES project(id),
  name                      text NOT NULL DEFAULT 'default',
  url                       text NOT NULL,
  signing_secret_ciphertext bytea NOT NULL,
  active                    boolean NOT NULL DEFAULT true,
  verified_at               timestamptz,
  created_by                uuid REFERENCES administrator(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_notification_endpoint_one_active ON project_notification_endpoint (project_id) WHERE active;
CREATE TRIGGER project_notification_endpoint_touch BEFORE UPDATE ON project_notification_endpoint FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE entitlement (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id),
  route_id   uuid NOT NULL REFERENCES route(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, route_id)
);

CREATE TABLE entitlement_version (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id         uuid NOT NULL REFERENCES entitlement(id),
  sequence               integer NOT NULL CHECK (sequence >= 1),
  minimum_amount         bigint CHECK (minimum_amount >= 0),
  maximum_amount         bigint CHECK (maximum_amount >= 0),
  count_24h              integer NOT NULL CHECK (count_24h >= 0),
  value_24h              bigint NOT NULL CHECK (value_24h >= 0),
  count_30d              integer NOT NULL CHECK (count_30d >= 0),
  value_30d              bigint NOT NULL CHECK (value_30d >= 0),
  processing_fee_bps     integer CHECK (processing_fee_bps >= 0),
  processing_fee_fixed   bigint CHECK (processing_fee_fixed >= 0),
  platform_fee_bps       integer CHECK (platform_fee_bps >= 0),
  platform_fee_fixed     bigint CHECK (platform_fee_fixed >= 0),
  processing_fee_bearer  text CHECK (processing_fee_bearer IN ('counterparty', 'project')),
  platform_fee_bearer    text CHECK (platform_fee_bearer IN ('counterparty', 'project')),
  active                 boolean NOT NULL DEFAULT true,
  valid_from             timestamptz NOT NULL DEFAULT now(),
  valid_to               timestamptz,
  created_by             uuid REFERENCES administrator(id),
  note                   text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entitlement_id, sequence),
  CHECK ((processing_fee_bps IS NULL) = (processing_fee_fixed IS NULL)),
  CHECK ((platform_fee_bps IS NULL) = (platform_fee_fixed IS NULL))
);
CREATE UNIQUE INDEX entitlement_version_one_open ON entitlement_version (entitlement_id) WHERE valid_to IS NULL;
CREATE TRIGGER entitlement_version_no_delete BEFORE DELETE ON entitlement_version FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- ---------------------------------------------------------------- ledger

CREATE TABLE ledger_account (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                   text NOT NULL CHECK (type IN (
                           'project_available', 'project_reserved', 'float', 'processing_revenue', 'platform_revenue',
                           'fee_expense', 'settlement', 'business_capital', 'suspense')),
  currency_code          char(3) NOT NULL REFERENCES currency(code),
  project_id             uuid REFERENCES project(id),
  provider_account_id    uuid REFERENCES provider_account(id),
  country_code           char(2) REFERENCES country(code),
  direction              text CHECK (direction IN ('collection', 'disbursement')),
  settlement_destination text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (
    CASE type
      WHEN 'project_available' THEN project_id IS NOT NULL AND provider_account_id IS NULL AND country_code IS NULL AND direction IS NULL AND settlement_destination IS NULL
      WHEN 'project_reserved'  THEN project_id IS NOT NULL AND provider_account_id IS NULL AND country_code IS NULL AND direction IS NULL AND settlement_destination IS NULL
      WHEN 'float'             THEN project_id IS NULL AND provider_account_id IS NOT NULL AND country_code IS NOT NULL AND direction IS NOT NULL AND settlement_destination IS NULL
      WHEN 'settlement'        THEN project_id IS NULL AND provider_account_id IS NULL AND country_code IS NULL AND direction IS NULL AND settlement_destination IS NOT NULL
      ELSE project_id IS NULL AND provider_account_id IS NULL AND country_code IS NULL AND direction IS NULL AND settlement_destination IS NULL
    END
  )
);
CREATE UNIQUE INDEX ledger_account_project_key ON ledger_account (type, project_id, currency_code) WHERE type IN ('project_available', 'project_reserved');
CREATE UNIQUE INDEX ledger_account_float_key ON ledger_account (provider_account_id, country_code, currency_code, direction) WHERE type = 'float';
CREATE UNIQUE INDEX ledger_account_settlement_key ON ledger_account (settlement_destination, currency_code) WHERE type = 'settlement';
CREATE UNIQUE INDEX ledger_account_global_key ON ledger_account (type, currency_code) WHERE type IN ('processing_revenue', 'platform_revenue', 'fee_expense', 'business_capital', 'suspense');
CREATE TRIGGER ledger_account_immutable BEFORE UPDATE OR DELETE ON ledger_account FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE ledger_entry (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type         text NOT NULL CHECK (entry_type IN (
                       'collection', 'disbursement_reservation', 'disbursement_settlement', 'disbursement_release',
                       'disbursement_suspension', 'suspense_settlement', 'suspense_release', 'float_transfer', 'cashout',
                       'float_funding', 'project_funding', 'adjustment', 'reversal', 'refund')),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  transaction_id     uuid,
  author_id          uuid REFERENCES administrator(id),
  justification      text,
  reverses_entry_id  uuid REFERENCES ledger_entry(id),
  discrepancy_id     uuid,
  reference          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (entry_type NOT IN ('adjustment', 'reversal', 'float_funding', 'project_funding') OR (author_id IS NOT NULL AND justification IS NOT NULL)),
  CHECK (entry_type <> 'reversal' OR reverses_entry_id IS NOT NULL)
);
CREATE INDEX ledger_entry_transaction_idx ON ledger_entry (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON ledger_entry FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE ledger_posting (
  id         bigserial PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES ledger_entry(id),
  account_id uuid NOT NULL REFERENCES ledger_account(id),
  side       text NOT NULL CHECK (side IN ('debit', 'credit')),
  amount     bigint NOT NULL CHECK (amount > 0)
);
CREATE INDEX ledger_posting_account_idx ON ledger_posting (account_id, id);
CREATE INDEX ledger_posting_entry_idx ON ledger_posting (entry_id);
CREATE TRIGGER ledger_posting_append_only BEFORE UPDATE OR DELETE ON ledger_posting FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Postings within one entry sum to zero and share one currency, checked when the transaction commits.
CREATE OR REPLACE FUNCTION ledger_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debits bigint; credits bigint; n_currencies integer; n_postings integer;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN p.side = 'debit' THEN p.amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN p.side = 'credit' THEN p.amount ELSE 0 END), 0),
         COUNT(DISTINCT a.currency_code), COUNT(*)
    INTO debits, credits, n_currencies, n_postings
    FROM ledger_posting p JOIN ledger_account a ON a.id = p.account_id
   WHERE p.entry_id = NEW.entry_id;
  IF debits <> credits THEN
    RAISE EXCEPTION 'ledger entry % is unbalanced: debits % credits %', NEW.entry_id, debits, credits USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF n_currencies <> 1 THEN
    RAISE EXCEPTION 'ledger entry % mixes currencies', NEW.entry_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF n_postings < 2 THEN
    RAISE EXCEPTION 'ledger entry % needs at least two postings', NEW.entry_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_posting_balanced AFTER INSERT ON ledger_posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_balanced();

CREATE TABLE ledger_checkpoint (
  id               bigserial PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES ledger_account(id),
  balance          bigint NOT NULL,
  through_posting_id bigint NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_checkpoint_account_idx ON ledger_checkpoint (account_id, through_posting_id DESC);
CREATE TRIGGER ledger_checkpoint_append_only BEFORE UPDATE OR DELETE ON ledger_checkpoint FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- ---------------------------------------------------------------- previews and transactions

CREATE TABLE preview (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                text NOT NULL UNIQUE,
  project_id               uuid NOT NULL REFERENCES project(id),
  route_id                 uuid NOT NULL REFERENCES route(id),
  route_version_id         uuid NOT NULL REFERENCES route_version(id),
  entitlement_version_id   uuid NOT NULL REFERENCES entitlement_version(id),
  binding_id               uuid REFERENCES route_binding(id),
  direction                text NOT NULL CHECK (direction IN ('collection', 'disbursement')),
  currency_code            char(3) NOT NULL REFERENCES currency(code),
  requested_amount         bigint NOT NULL CHECK (requested_amount > 0),
  processing_fee           bigint NOT NULL CHECK (processing_fee >= 0),
  platform_fee             bigint NOT NULL CHECK (platform_fee >= 0),
  processing_fee_bearer    text NOT NULL CHECK (processing_fee_bearer IN ('counterparty', 'project')),
  platform_fee_bearer      text NOT NULL CHECK (platform_fee_bearer IN ('counterparty', 'project')),
  charged_amount           bigint NOT NULL CHECK (charged_amount >= 0),
  settled_amount           bigint NOT NULL CHECK (settled_amount >= 0),
  expected_provider_fee    bigint NOT NULL CHECK (expected_provider_fee >= 0),
  fee_rounding_remainder   jsonb NOT NULL DEFAULT '{}'::jsonb,
  msisdn_ciphertext        bytea NOT NULL,
  msisdn_index             bytea NOT NULL,
  msisdn_masked            text NOT NULL,
  counterparty_name        text,
  counterparty_email       text,
  project_reference        text NOT NULL CHECK (char_length(project_reference) BETWEEN 1 AND 128),
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  payer_action             text NOT NULL CHECK (payer_action IN ('none', 'code', 'browser')),
  terms_snapshot           jsonb NOT NULL,
  limits_snapshot          jsonb NOT NULL,
  correlation_id           text NOT NULL,
  expires_at               timestamptz NOT NULL,
  status                   text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'expired')),
  transaction_id           uuid,
  confirmed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX preview_open_project_reference ON preview (project_id, project_reference) WHERE status = 'open';
CREATE INDEX preview_project_created_idx ON preview (project_id, created_at DESC);
CREATE INDEX preview_msisdn_idx ON preview (msisdn_index, created_at DESC);
CREATE INDEX preview_expiry_idx ON preview (expires_at) WHERE status = 'open';

CREATE TABLE transaction (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                text NOT NULL UNIQUE,
  preview_id               uuid NOT NULL UNIQUE REFERENCES preview(id),
  project_id               uuid NOT NULL REFERENCES project(id),
  route_id                 uuid NOT NULL REFERENCES route(id),
  route_version_id         uuid NOT NULL REFERENCES route_version(id),
  entitlement_version_id   uuid NOT NULL REFERENCES entitlement_version(id),
  direction                text NOT NULL CHECK (direction IN ('collection', 'disbursement')),
  state                    text NOT NULL CHECK (state IN ('created', 'action_required', 'submitted', 'processing', 'succeeded', 'failed', 'expired', 'undetermined')),
  reconciliation_status    text NOT NULL DEFAULT 'unreviewed' CHECK (reconciliation_status IN ('unreviewed', 'matched', 'disputed', 'examined', 'corrected')),
  currency_code            char(3) NOT NULL REFERENCES currency(code),
  requested_amount         bigint NOT NULL CHECK (requested_amount > 0),
  charged_amount           bigint NOT NULL CHECK (charged_amount >= 0),
  settled_amount           bigint CHECK (settled_amount >= 0),
  expected_settled_amount  bigint NOT NULL CHECK (expected_settled_amount >= 0),
  processing_fee           bigint NOT NULL CHECK (processing_fee >= 0),
  platform_fee             bigint NOT NULL CHECK (platform_fee >= 0),
  processing_fee_bearer    text NOT NULL CHECK (processing_fee_bearer IN ('counterparty', 'project')),
  platform_fee_bearer      text NOT NULL CHECK (platform_fee_bearer IN ('counterparty', 'project')),
  expected_provider_fee    bigint NOT NULL CHECK (expected_provider_fee >= 0),
  actual_provider_fee      bigint CHECK (actual_provider_fee >= 0),
  reserved_amount          bigint NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  msisdn_ciphertext        bytea NOT NULL,
  msisdn_index             bytea NOT NULL,
  msisdn_masked            text NOT NULL,
  counterparty_name        text,
  counterparty_email       text,
  project_reference        text NOT NULL,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  terms_snapshot           jsonb NOT NULL,
  limits_snapshot          jsonb NOT NULL,
  original_transaction_id  uuid REFERENCES transaction(id),
  payer_action             text NOT NULL CHECK (payer_action IN ('none', 'code', 'browser')),
  action_expires_at        timestamptz,
  action_url_ciphertext    bytea,
  code_attempts_remaining  integer,
  current_attempt_id       uuid,
  binding_id               uuid REFERENCES route_binding(id),
  selected_provider_account_id uuid REFERENCES provider_account(id),
  failure_reason           text,
  terminal_at              timestamptz,
  next_status_check_at     timestamptz,
  status_check_count       integer NOT NULL DEFAULT 0,
  sweep_ceiling_at         timestamptz NOT NULL,
  correlation_id           text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, project_reference),
  CHECK (state NOT IN ('succeeded', 'failed', 'expired') OR terminal_at IS NOT NULL),
  CHECK (state <> 'succeeded' OR settled_amount IS NOT NULL),
  CHECK (state NOT IN ('failed', 'expired') OR failure_reason IS NOT NULL)
);
CREATE INDEX transaction_project_created_idx ON transaction (project_id, created_at DESC);
CREATE INDEX transaction_state_idx ON transaction (state, next_status_check_at) WHERE state IN ('created', 'action_required', 'submitted', 'processing');
CREATE INDEX transaction_open_similar_idx ON transaction (project_id, route_id, requested_amount, msisdn_index) WHERE state IN ('created', 'action_required', 'submitted', 'processing', 'undetermined');
CREATE INDEX transaction_msisdn_idx ON transaction (msisdn_index, created_at DESC);
CREATE INDEX transaction_terminal_idx ON transaction (terminal_at DESC) WHERE terminal_at IS NOT NULL;
CREATE INDEX transaction_route_created_idx ON transaction (route_id, created_at DESC);
CREATE TRIGGER transaction_touch BEFORE UPDATE ON transaction FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
ALTER TABLE preview ADD CONSTRAINT preview_transaction_fk FOREIGN KEY (transaction_id) REFERENCES transaction(id);
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_transaction_fk FOREIGN KEY (transaction_id) REFERENCES transaction(id);

CREATE TABLE provider_payload (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_account_id uuid REFERENCES provider_account(id),
  transaction_id      uuid REFERENCES transaction(id),
  flow                text NOT NULL CHECK (flow IN ('outbound_request', 'outbound_response', 'inbound_notification')),
  kind                text NOT NULL,
  body                jsonb NOT NULL,
  correlation_id      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_payload_transaction_idx ON provider_payload (transaction_id, created_at);
CREATE INDEX provider_payload_created_idx ON provider_payload (created_at);

CREATE TABLE transaction_attempt (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id         uuid NOT NULL REFERENCES transaction(id),
  sequence               integer NOT NULL CHECK (sequence >= 1),
  provider_account_id    uuid NOT NULL REFERENCES provider_account(id),
  binding_id             uuid REFERENCES route_binding(id),
  binding_snapshot       jsonb NOT NULL,
  provider_reference     text,
  operator_reference     text,
  state                  text NOT NULL CHECK (state IN ('submitting', 'action_required', 'processing', 'succeeded', 'failed', 'undetermined')),
  actual_provider_fee    bigint CHECK (actual_provider_fee >= 0),
  request_payload_id     uuid REFERENCES provider_payload(id),
  response_payload_id    uuid REFERENCES provider_payload(id),
  started_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz,
  failure_reason         text,
  provider_error_code    text,
  provider_error_message text,
  UNIQUE (transaction_id, sequence)
);
CREATE INDEX transaction_attempt_provider_ref_idx ON transaction_attempt (provider_account_id, provider_reference);
CREATE INDEX transaction_attempt_operator_ref_idx ON transaction_attempt (operator_reference) WHERE operator_reference IS NOT NULL;
ALTER TABLE transaction ADD CONSTRAINT transaction_current_attempt_fk FOREIGN KEY (current_attempt_id) REFERENCES transaction_attempt(id);

CREATE TABLE transaction_event (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transaction(id),
  prior_state    text,
  new_state      text NOT NULL,
  source         text NOT NULL CHECK (source IN ('provider_response', 'notification', 'status_check', 'reconciliation', 'administrator', 'system')),
  actor_id       uuid REFERENCES administrator(id),
  payload_id     uuid REFERENCES provider_payload(id),
  discrepancy_id uuid,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_event_transaction_idx ON transaction_event (transaction_id, id);
CREATE TRIGGER transaction_event_append_only BEFORE UPDATE OR DELETE ON transaction_event FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- Inbound provider notifications are processed once per (account, provider reference, event).
CREATE TABLE provider_notification_receipt (
  provider_account_id uuid NOT NULL REFERENCES provider_account(id),
  provider_reference  text NOT NULL,
  event_key           text NOT NULL,
  payload_id          uuid REFERENCES provider_payload(id),
  received_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_account_id, provider_reference, event_key)
);

-- ---------------------------------------------------------------- notifications to projects

CREATE TABLE notification_delivery (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text NOT NULL,
  transaction_id  uuid NOT NULL REFERENCES transaction(id),
  endpoint_id     uuid NOT NULL REFERENCES project_notification_endpoint(id),
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  attempt         integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 8,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'exhausted')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  replayed_from   uuid REFERENCES notification_delivery(id),
  replayed_by     uuid REFERENCES administrator(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_delivery_due_idx ON notification_delivery (next_attempt_at) WHERE status = 'pending';
CREATE INDEX notification_delivery_transaction_idx ON notification_delivery (transaction_id, created_at DESC);
CREATE INDEX notification_delivery_endpoint_idx ON notification_delivery (endpoint_id, created_at DESC);

CREATE TABLE notification_delivery_attempt (
  id              bigserial PRIMARY KEY,
  delivery_id     uuid NOT NULL REFERENCES notification_delivery(id),
  attempt         integer NOT NULL,
  response_status integer,
  response_body   text,
  error           text,
  duration_ms     integer,
  attempted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_delivery_attempt_delivery_idx ON notification_delivery_attempt (delivery_id, attempt);

-- ---------------------------------------------------------------- background jobs

CREATE TABLE job (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead')),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX job_due_idx ON job (run_at) WHERE status = 'queued';
CREATE UNIQUE INDEX job_dedupe_idx ON job (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE rate_limit_window (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- ---------------------------------------------------------------- treasury

CREATE TABLE float_threshold (
  account_id      uuid PRIMARY KEY REFERENCES ledger_account(id),
  target_hours    integer NOT NULL DEFAULT 168 CHECK (target_hours > 0),
  minimum_hours   integer NOT NULL DEFAULT 72 CHECK (minimum_hours > 0),
  override_amount bigint CHECK (override_amount >= 0),
  updated_by      uuid REFERENCES administrator(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (minimum_hours < target_hours)
);

CREATE TABLE float_transfer (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_account_id    uuid NOT NULL REFERENCES provider_account(id),
  source_account_id      uuid NOT NULL REFERENCES ledger_account(id),
  destination_account_id uuid NOT NULL REFERENCES ledger_account(id),
  currency_code          char(3) NOT NULL REFERENCES currency(code),
  amount                 bigint NOT NULL CHECK (amount > 0),
  provider_fee           bigint NOT NULL DEFAULT 0 CHECK (provider_fee >= 0),
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  execution_path         text NOT NULL CHECK (execution_path IN ('platform', 'registered')),
  provider_reference     text,
  initiated_by           uuid NOT NULL REFERENCES administrator(id),
  ledger_entry_id        uuid REFERENCES ledger_entry(id),
  confirming_run_id      uuid,
  confirmed_at           timestamptz,
  note                   text NOT NULL DEFAULT '',
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (source_account_id <> destination_account_id)
);

CREATE TABLE cashout (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  float_account_id         uuid NOT NULL REFERENCES ledger_account(id),
  settlement_account_id    uuid NOT NULL REFERENCES ledger_account(id),
  currency_code            char(3) NOT NULL REFERENCES currency(code),
  amount                   bigint NOT NULL CHECK (amount > 0),
  status                   text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'declined', 'confirmed')),
  destination_reference    text NOT NULL,
  initiated_by             uuid NOT NULL REFERENCES administrator(id),
  approved_by              uuid REFERENCES administrator(id),
  supporting_document      text,
  solvency_remainder       bigint NOT NULL,
  liquidity_remainder      bigint NOT NULL,
  ledger_entry_id          uuid REFERENCES ledger_entry(id),
  confirmed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (initiated_by <> approved_by)
);

-- ---------------------------------------------------------------- reconciliation

CREATE TABLE statement_import (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_account_id   uuid NOT NULL REFERENCES provider_account(id),
  filename              text NOT NULL,
  checksum              bytea NOT NULL UNIQUE,
  declared_period_start timestamptz NOT NULL,
  declared_period_end   timestamptz NOT NULL,
  observed_period_start timestamptz,
  observed_period_end   timestamptz,
  row_count             integer NOT NULL DEFAULT 0,
  rows_rejected         integer NOT NULL DEFAULT 0,
  rejected_rows         jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by           uuid NOT NULL REFERENCES administrator(id),
  run_id                uuid,
  status                text NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed', 'confirmed', 'rejected')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (declared_period_end > declared_period_start)
);

CREATE TABLE statement_row (
  import_id          uuid NOT NULL REFERENCES statement_import(id) ON DELETE CASCADE,
  row_number         integer NOT NULL,
  provider_reference text NOT NULL,
  external_reference text,
  direction          text CHECK (direction IN ('collection', 'disbursement')),
  amount             bigint,
  fee                bigint,
  currency_code      char(3),
  status             text,
  occurred_at        timestamptz,
  raw                jsonb NOT NULL,
  PRIMARY KEY (import_id, row_number)
);
CREATE INDEX statement_row_provider_ref_idx ON statement_row (import_id, provider_reference);

CREATE TABLE reconciliation_run (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_account_id  uuid NOT NULL REFERENCES provider_account(id),
  mode                 text NOT NULL CHECK (mode IN ('automated', 'manual')),
  statement_import_id  uuid REFERENCES statement_import(id),
  period_start         timestamptz NOT NULL,
  period_end           timestamptz NOT NULL,
  started_by           uuid REFERENCES administrator(id),
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  status               text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  records_compared     integer NOT NULL DEFAULT 0,
  discrepancies_raised integer NOT NULL DEFAULT 0,
  summary              jsonb NOT NULL DEFAULT '{}'::jsonb,
  error                text
);
CREATE UNIQUE INDEX reconciliation_run_one_running ON reconciliation_run (provider_account_id) WHERE status = 'running';
CREATE INDEX reconciliation_run_account_idx ON reconciliation_run (provider_account_id, started_at DESC);
ALTER TABLE statement_import ADD CONSTRAINT statement_import_run_fk FOREIGN KEY (run_id) REFERENCES reconciliation_run(id);
ALTER TABLE float_transfer ADD CONSTRAINT float_transfer_run_fk FOREIGN KEY (confirming_run_id) REFERENCES reconciliation_run(id);

CREATE TABLE discrepancy (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               uuid NOT NULL REFERENCES reconciliation_run(id),
  provider_account_id  uuid NOT NULL REFERENCES provider_account(id),
  type                 text NOT NULL CHECK (type IN ('float_drift', 'fee_variance', 'orphan_transaction', 'missing_transaction', 'state_divergence', 'stale_undetermined', 'unconfirmed_transfer', 'checkpoint_mismatch')),
  subject_type         text NOT NULL,
  subject_reference    text NOT NULL,
  transaction_id       uuid REFERENCES transaction(id),
  float_account_id     uuid REFERENCES ledger_account(id),
  float_transfer_id    uuid REFERENCES float_transfer(id),
  fingerprint          text NOT NULL UNIQUE,
  expected             jsonb NOT NULL,
  observed             jsonb NOT NULL,
  difference           bigint,
  currency_code        char(3) REFERENCES currency(code),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved')),
  assignee_id          uuid REFERENCES administrator(id),
  first_detected_at    timestamptz NOT NULL DEFAULT now(),
  last_detected_at     timestamptz NOT NULL DEFAULT now(),
  runs_seen            integer NOT NULL DEFAULT 1,
  recurrences_after_resolution integer NOT NULL DEFAULT 0,
  decision             text CHECK (decision IN ('accepted', 'rejected')),
  adjustment_posted    boolean NOT NULL DEFAULT false,
  resolving_entry_id   uuid REFERENCES ledger_entry(id),
  resolved_by          uuid REFERENCES administrator(id),
  approved_by          uuid REFERENCES administrator(id),
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discrepancy_status_idx ON discrepancy (status, first_detected_at DESC);
CREATE INDEX discrepancy_transaction_idx ON discrepancy (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX discrepancy_run_idx ON discrepancy (run_id);
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_discrepancy_fk FOREIGN KEY (discrepancy_id) REFERENCES discrepancy(id);
ALTER TABLE transaction_event ADD CONSTRAINT transaction_event_discrepancy_fk FOREIGN KEY (discrepancy_id) REFERENCES discrepancy(id);

CREATE TABLE discrepancy_comment (
  id             bigserial PRIMARY KEY,
  discrepancy_id uuid NOT NULL REFERENCES discrepancy(id),
  author_id      uuid NOT NULL REFERENCES administrator(id),
  body           text NOT NULL CHECK (char_length(body) > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discrepancy_comment_idx ON discrepancy_comment (discrepancy_id, id);
CREATE TRIGGER discrepancy_comment_append_only BEFORE UPDATE OR DELETE ON discrepancy_comment FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- ---------------------------------------------------------------- roles, confirmations, approvals, audit

CREATE TABLE role_assignment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_id uuid NOT NULL REFERENCES administrator(id),
  role_id          uuid NOT NULL REFERENCES role(id),
  scope_type       text NOT NULL CHECK (scope_type IN ('all', 'projects', 'provider_accounts')),
  granted_by       uuid REFERENCES administrator(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX role_assignment_admin_idx ON role_assignment (administrator_id);

CREATE TABLE role_assignment_scope (
  assignment_id       uuid NOT NULL REFERENCES role_assignment(id) ON DELETE CASCADE,
  project_id          uuid REFERENCES project(id),
  provider_account_id uuid REFERENCES provider_account(id),
  CHECK ((project_id IS NULL) <> (provider_account_id IS NULL))
);
CREATE INDEX role_assignment_scope_idx ON role_assignment_scope (assignment_id);

CREATE TABLE operation_confirmation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_id  uuid NOT NULL REFERENCES administrator(id),
  operation_type    text NOT NULL,
  subject_reference text NOT NULL DEFAULT '',
  fingerprint       text NOT NULL,
  code_hash         bytea NOT NULL,
  issued_at         timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  outcome           text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'confirmed', 'expired', 'abandoned', 'exhausted')),
  consumed_at       timestamptz
);
CREATE INDEX operation_confirmation_admin_idx ON operation_confirmation (administrator_id, issued_at DESC);

CREATE TABLE approval_request (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,
  subject         jsonb NOT NULL,
  summary         text NOT NULL,
  amount          bigint,
  currency_code   char(3) REFERENCES currency(code),
  initiated_by    uuid NOT NULL REFERENCES administrator(id),
  justification   text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by      uuid REFERENCES administrator(id),
  decision_reason text,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> initiated_by)
);
CREATE INDEX approval_request_pending_idx ON approval_request (created_at) WHERE status = 'pending';

CREATE TABLE audit_record (
  id              bigserial PRIMARY KEY,
  actor_id        uuid REFERENCES administrator(id),
  action          text NOT NULL,
  subject_type    text NOT NULL,
  subject_id      text NOT NULL,
  prior_state     jsonb,
  new_state       jsonb,
  confirmation_id uuid REFERENCES operation_confirmation(id),
  approved_by     uuid REFERENCES administrator(id),
  correlation_id  text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_record_subject_idx ON audit_record (subject_type, subject_id, id DESC);
CREATE INDEX audit_record_actor_idx ON audit_record (actor_id, id DESC);
CREATE TRIGGER audit_record_append_only BEFORE UPDATE OR DELETE ON audit_record FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE TABLE export_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_id uuid NOT NULL REFERENCES administrator(id),
  subject          text NOT NULL,
  filters          jsonb NOT NULL,
  row_count        integer NOT NULL,
  environment      text NOT NULL,
  signature        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- alerts

CREATE TABLE alert_group (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE alert_group_member (
  group_id         uuid NOT NULL REFERENCES alert_group(id) ON DELETE CASCADE,
  administrator_id uuid NOT NULL REFERENCES administrator(id),
  PRIMARY KEY (group_id, administrator_id)
);

CREATE TABLE alert_group_address (
  group_id uuid NOT NULL REFERENCES alert_group(id) ON DELETE CASCADE,
  channel  text NOT NULL CHECK (channel IN ('email', 'chat')),
  address  text NOT NULL,
  active   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (group_id, channel)
);

CREATE TABLE alert_policy (
  category                text PRIMARY KEY CHECK (category IN ('treasury', 'service_health', 'reconciliation', 'security')),
  minimum_severity        text NOT NULL DEFAULT 'warning' CHECK (minimum_severity IN ('informational', 'warning', 'critical')),
  acknowledgement_required boolean NOT NULL DEFAULT false,
  escalation_minutes      integer NOT NULL DEFAULT 30,
  escalation_group_id     uuid REFERENCES alert_group(id),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_policy_group (
  category text NOT NULL REFERENCES alert_policy(category) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES alert_group(id),
  PRIMARY KEY (category, group_id)
);

CREATE TABLE alert (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category            text NOT NULL CHECK (category IN ('treasury', 'service_health', 'reconciliation', 'security')),
  severity            text NOT NULL CHECK (severity IN ('informational', 'warning', 'critical')),
  subject_type        text NOT NULL,
  subject_reference   text NOT NULL,
  project_id          uuid REFERENCES project(id),
  fingerprint         text NOT NULL,
  title               text NOT NULL,
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_reference    text NOT NULL,
  raised_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_notified_at    timestamptz,
  occurrence_count    integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'cleared')),
  acknowledged_by     uuid REFERENCES administrator(id),
  acknowledged_at     timestamptz,
  escalated_at        timestamptz,
  cleared_at          timestamptz
);
CREATE UNIQUE INDEX alert_one_open_per_fingerprint ON alert (fingerprint) WHERE status IN ('open', 'acknowledged');
CREATE INDEX alert_status_idx ON alert (status, severity, raised_at DESC);

CREATE TABLE alert_delivery (
  id        bigserial PRIMARY KEY,
  alert_id  uuid NOT NULL REFERENCES alert(id),
  group_id  uuid REFERENCES alert_group(id),
  channel   text NOT NULL,
  address   text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('raised', 'renotified', 'escalated', 'cleared')),
  attempt   integer NOT NULL DEFAULT 1,
  status    text NOT NULL CHECK (status IN ('sent', 'failed', 'logged')),
  response  text,
  sent_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_delivery_alert_idx ON alert_delivery (alert_id, id);

-- ---------------------------------------------------------------- platform settings (configured values, spec 14.7)

CREATE TABLE platform_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES administrator(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
