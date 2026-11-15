-- Payment links: a project publishes a page where anyone can pay it, in the project's own brand.

-- Images are stored in the database and served by id; SVG is refused because it can carry script.
CREATE TABLE brand_asset (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id),
  bytes        bytea NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  sha256       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_asset_project_idx ON brand_asset (project_id);

CREATE TABLE project_brand (
  project_id      uuid PRIMARY KEY REFERENCES project(id),
  logo_asset_id   uuid REFERENCES brand_asset(id),
  primary_color   text NOT NULL,
  secondary_color text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER project_brand_touch BEFORE UPDATE ON project_brand FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE payment_link (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  project_id      uuid NOT NULL REFERENCES project(id),
  title           text NOT NULL,
  description     text,
  currency_code   char(3) NOT NULL REFERENCES currency(code),
  amount_type     text NOT NULL CHECK (amount_type IN ('fixed', 'free')),
  amount          bigint,
  minimum_amount  bigint NOT NULL DEFAULT 0,
  single_use      boolean NOT NULL DEFAULT false,
  expires_at      timestamptz,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'completed')),
  -- The brand is copied onto the link when it is created, so changing the project's brand later does not repaint a link already shared.
  logo_asset_id   uuid REFERENCES brand_asset(id),
  primary_color   text NOT NULL,
  secondary_color text,
  created_by      uuid NOT NULL REFERENCES administrator(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_link_amount_check CHECK ((amount_type = 'fixed') = (amount IS NOT NULL))
);
CREATE INDEX payment_link_project_idx ON payment_link (project_id);
CREATE TRIGGER payment_link_touch BEFORE UPDATE ON payment_link FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The id is the method key the public page sends back, so the page never exposes route ids.
CREATE TABLE payment_link_route (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id  uuid NOT NULL REFERENCES payment_link(id),
  route_id uuid NOT NULL REFERENCES route(id),
  UNIQUE (link_id, route_id)
);

-- One row per payer attempt: a preview first, a transaction only once the payer confirms.
CREATE TABLE payment_link_payment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id          uuid NOT NULL REFERENCES payment_link(id),
  preview_id       uuid NOT NULL REFERENCES preview(id),
  transaction_id   uuid UNIQUE REFERENCES transaction(id),
  token_hash       bytea NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  receipts_sent    integer NOT NULL DEFAULT 0,
  receipt_sent_at  timestamptz,
  -- Masked: the address the receipt went to is never stored in clear.
  receipt_sent_to  text
);
CREATE INDEX payment_link_payment_link_idx ON payment_link_payment (link_id);

ALTER TABLE transaction ADD COLUMN payment_link_id uuid REFERENCES payment_link(id);
CREATE INDEX transaction_payment_link_idx ON transaction (payment_link_id) WHERE payment_link_id IS NOT NULL;

-- Per-route text for the waiting screen: { "en": string, "fr": string }.
ALTER TABLE route ADD COLUMN payer_instructions jsonb;

INSERT INTO role_permission (role_id, permission_key)
SELECT id, 'links.manage' FROM role WHERE name IN ('Owner', 'Client owner')
ON CONFLICT DO NOTHING;
