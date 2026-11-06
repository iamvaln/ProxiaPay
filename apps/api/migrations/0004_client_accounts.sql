-- Client accounts: integrators sign in to the console as members of a client, one client at a time.

CREATE TABLE client (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by uuid REFERENCES administrator(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER client_touch BEFORE UPDATE ON client FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A null password hash means "invited, no password yet".
ALTER TABLE administrator ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE administrator ADD COLUMN kind text NOT NULL DEFAULT 'platform' CHECK (kind IN ('platform', 'client'));
ALTER TABLE administrator ADD COLUMN last_client_id uuid REFERENCES client(id);

CREATE TABLE client_membership (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES client(id),
  administrator_id   uuid NOT NULL REFERENCES administrator(id),
  status             text NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  disabled_by_client boolean NOT NULL DEFAULT false,
  invited_by         uuid REFERENCES administrator(id),
  -- The name the inviter typed, shown while pending: an existing account's own name would tell the inviter it exists.
  invited_name       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz,
  UNIQUE (client_id, administrator_id)
);
CREATE INDEX client_membership_admin_idx ON client_membership (administrator_id);

CREATE TABLE invitation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES client_membership(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  sets_password boolean NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitation_membership_idx ON invitation (membership_id);

ALTER TABLE project ADD COLUMN client_id uuid REFERENCES client(id);
CREATE INDEX project_client_idx ON project (client_id);

ALTER TABLE role ADD COLUMN kind text NOT NULL DEFAULT 'platform' CHECK (kind IN ('platform', 'client'));

ALTER TABLE role_assignment ADD COLUMN membership_id uuid REFERENCES client_membership(id) ON DELETE CASCADE;
ALTER TABLE role_assignment DROP CONSTRAINT role_assignment_scope_type_check;
ALTER TABLE role_assignment ADD CONSTRAINT role_assignment_scope_type_check CHECK (scope_type IN ('all', 'projects', 'provider_accounts', 'client'));
ALTER TABLE role_assignment ADD CONSTRAINT role_assignment_client_membership_check CHECK (scope_type <> 'client' OR membership_id IS NOT NULL);

ALTER TABLE admin_session ADD COLUMN active_client_id uuid REFERENCES client(id);

-- Production never re-runs the seed, so the roles are created here. Idempotent: a fresh database seeds them again afterwards.
INSERT INTO role (name, description, seeded, kind) VALUES
  ('Client owner', 'Runs a client: its projects, credentials and team.', true, 'client'),
  ('Client developer', 'Integrates a client''s projects: credentials, origins and notifications.', true, 'client'),
  ('Client finance', 'Reads a client''s payments and balances, and exports them.', true, 'client')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, p.permission_key
  FROM role r
  JOIN (VALUES
    ('Client owner', 'transactions.read'), ('Client owner', 'projects.read'), ('Client owner', 'projects.create_own'),
    ('Client owner', 'projects.credentials'), ('Client owner', 'projects.origins'), ('Client owner', 'projects.notifications'),
    ('Client owner', 'treasury.read_balances'), ('Client owner', 'oversight.export'), ('Client owner', 'client.members'),
    ('Client developer', 'transactions.read'), ('Client developer', 'projects.read'), ('Client developer', 'projects.credentials'),
    ('Client developer', 'projects.origins'), ('Client developer', 'projects.notifications'), ('Client developer', 'treasury.read_balances'),
    ('Client finance', 'transactions.read'), ('Client finance', 'projects.read'), ('Client finance', 'treasury.read_balances'),
    ('Client finance', 'oversight.export')
  ) AS p(role_name, permission_key) ON p.role_name = r.name
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT id, 'admin.clients' FROM role WHERE name = 'Owner'
ON CONFLICT DO NOTHING;
