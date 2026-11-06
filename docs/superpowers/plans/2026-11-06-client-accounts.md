# Client Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let integrators have their own console accounts. A client owns projects and a team, works in one client at a time, and never sees another client or ProxiaPay's economics.

**Architecture:** A `client` owns projects. People join clients through `client_membership`, and role assignments hang off a membership. The session holds an active client, so `Authorisation` is computed from one membership at a time. A deny-by-default wall in `SessionGuard` refuses client principals on every console handler not marked `@ClientAccessible()`. The handlers that are open return client-shaped responses. Invitations are emailed single-use links.

**Tech Stack:** NestJS 11, Kysely, PostgreSQL 16 (plain SQL migrations), zod, Vitest; React 19 + Vite console, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-06-client-accounts-design.md`

## Global Constraints

- Deny by default: a client principal on a console handler without `@ClientAccessible()` gets `NOT_FOUND` ("Not found."), never `PERMISSION_DENIED`, which would confirm the handler exists.
- Client responses never carry the following:
  - provider account names or ids, provider fees (`expected_fee_bps`, `actual_provider_fee`, binding snapshots), `margin`, platform revenue;
  - platform ledger account ids;
  - `route_version` / `entitlement_version` rows;
  - internal notes, `created_by` or administrator names other than the client's own team.
- Payer numbers are always masked for client accounts. No client role holds `transactions.read_identifiers`.
- Every scope for a client principal is computed from its **active** membership only.
- Client role names, fixed in code: `Client owner`, `Client developer`, `Client finance`. API profile keys: `developer`, `finance`.
- New permissions:
  - `projects.create_own`: "Create projects for one's own client";
  - `client.members`: "Manage one's own client team";
  - `admin.clients`: "Manage clients and their owners", added to `SENSITIVE_PERMISSIONS`.
- Invitation links expire after 72 hours. Tokens are stored hashed, like session tokens.
- Sandbox auto-entitlements:
  - `SANDBOX_AUTO_ENTITLE=true`; the API refuses to boot with it in production, exactly as `SANDBOX_ANY_SECOND_FACTOR` does;
  - limits: count_24h 1000, value_24h 100000000, count_30d 1000, value_30d 100000000, fees inherited.
- The new roles and permissions are created by migration `0004`, not only by `seed`. Production never re-runs `seed`.
- Console copy is in English and French (`apps/console/src/lib/i18n.ts`); no hard-coded user-facing strings in new UI.
- Commit messages carry no AI attribution trailer (user's CLAUDE.md).

## Review Focus

1. **A person in two clients switches client.** After the switch, lists, search, export, home and project pages show only the new client's projects. A stale page that refetches gets `NOT_FOUND` for the old client's ids. Pinned in Task 3 and Task 4.
2. **Inviting an address that already exists** (another client's member, a platform account, an already-invited pending address) answers the same `{ status: 'invitation_sent' }`, and creates no duplicate account or membership. Pinned in Task 9.
3. **An owner editing a member** cannot:
   - add a project of another client;
   - give a platform role or the owner role;
   - edit their own membership;
   - edit a member of another client by id.

   Pinned in Task 9.
4. **A new endpoint added later** is closed to clients unless marked. Pinned by the route-walking contract test in Task 4.
5. **An expired, used or forged invitation token** is refused with one neutral message, and the set-password endpoint never reveals whether the email exists. Pinned in Task 9.

---

### Task 1: Schema, roles and permissions

**Files:**
- Create: `apps/api/migrations/0004_client_accounts.sql`
- Modify: `apps/api/src/permissions/permissions.ts`, `apps/api/src/seed/seed.ts`, `apps/api/src/db/schema.generated.ts` (regenerate or hand-edit the same way 0002/0003 did)
- Test: `apps/api/src/seed/client-roles.test.ts`

**Interfaces:**
- Produces:
  - tables `client`, `client_membership` and `invitation`;
  - columns `project.client_id`, `administrator.kind`, `administrator.last_client_id`, `role.kind`, `role_assignment.membership_id` and `admin_session.active_client_id`;
  - the scope type `'client'`;
  - in `permissions.ts`:
    - `CLIENT_ROLES: { name: string; profile: 'owner' | 'developer' | 'finance'; permissions: Permission[] }[]`;
    - `CLIENT_ONLY_PERMISSIONS: Permission[]`, holding `projects.create_own` and `client.members`;
    - `PLATFORM_PERMISSIONS`, equal to `ALL_PERMISSIONS` minus `CLIENT_ONLY_PERMISSIONS`.

  The `Owner` role is seeded with `PLATFORM_PERMISSIONS`.

Migration content:
- **`client`**: `id uuid pk default gen_random_uuid()`, `name text not null`, `status text not null default 'active' check (status in ('active','disabled'))`, `created_by uuid references administrator(id)`, `created_at`, `updated_at`, plus the `touch_updated_at` trigger.
- **`client_membership`**:
  - columns: `id uuid pk`, `client_id uuid not null references client(id)`, `administrator_id uuid not null references administrator(id)`, `status text not null check (status in ('pending','active','disabled'))`, `disabled_by_client boolean not null default false`, `invited_by uuid references administrator(id)`, `created_at`, `accepted_at timestamptz`;
  - constraint `unique (client_id, administrator_id)`.
- **`invitation`**: `id uuid pk`, `membership_id uuid not null references client_membership(id) on delete cascade`, `token_hash bytea not null unique`, `sets_password boolean not null`, `expires_at timestamptz not null`, `used_at timestamptz`, `created_at`.
- **`administrator`**:
  - `kind text not null default 'platform' check (kind in ('platform','client'))`;
  - `last_client_id uuid references client(id)`;
  - `password_hash` drops `NOT NULL`. A `null` hash means "invited, no password yet".
- **`project`**: `client_id uuid references client(id)`, with an index.
- **`role`**: `kind text not null default 'platform' check (kind in ('platform','client'))`.
- **`role_assignment`**:
  - `membership_id uuid references client_membership(id) on delete cascade`;
  - replace the `scope_type` check so it adds `'client'`;
  - check `(membership_id is null) = (scope_type <> 'client' and ...)`. Keep it simple: `scope_type = 'client'` implies `membership_id is not null`.
- **`admin_session`**: `active_client_id uuid references client(id)`.
- **Roles and permissions:**
  - insert the three client roles (`kind='client'`, `seeded=true`) with their permissions, idempotently (`on conflict do nothing`);
  - insert `admin.clients` into the existing `Owner` role.

Client role permissions, verbatim from the spec:

| Role | Permissions |
|---|---|
| Client owner | transactions.read, projects.read, projects.create_own, projects.credentials, projects.origins, projects.notifications, treasury.read_balances, oversight.export, client.members |
| Client developer | transactions.read, projects.read, projects.credentials, projects.origins, projects.notifications, treasury.read_balances |
| Client finance | transactions.read, projects.read, treasury.read_balances, oversight.export |

- [ ] **Step 1: Write the failing test** `client-roles.test.ts`, using `testDb()` and `seedReferenceData`. Its assertions:
  - the three client roles exist with `kind = 'client'` and exactly the permissions above;
  - `Owner` holds `admin.clients` and does not hold `projects.create_own` or `client.members`;
  - inserting a `role_assignment` with `scope_type = 'client'` and a null `membership_id` fails;
  - `administrator.password_hash` accepts null.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/seed/client-roles.test.ts`. Expected: FAIL (no migration).
- [ ] **Step 3: Write the migration, the permissions and the seed changes.** `seed.ts` also inserts the `CLIENT_ROLES` with `kind: 'client'`. `SEEDED_ROLES` stay `kind: 'platform'`.
- [ ] **Step 4: Run** the test, then `npx vitest run src/db src/seed`. Expected: PASS. Also `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** "Schema for clients, memberships and invitations".

### Task 2: Authorisation from the active membership

**Files:**
- Modify: `apps/api/src/admin-auth/authorisation.service.ts`, `apps/api/src/test/console-request.ts`
- Test: `apps/api/src/admin-auth/authorisation.test.ts` (create)

**Interfaces:**
- Consumes: the Task 1 schema.
- Produces:
  - `Authorisation` gains `readonly clientId: string | null` (the active client; `null` for platform staff) and `get isClient(): boolean`;
  - `AuthorisationService.load(administratorId: string, activeClientId: string | null): Promise<Authorisation>`.
  - For platform accounts it loads only assignments with `membership_id is null`, which is today's behaviour.
  - For client accounts it loads only assignments whose membership is `active`, belongs to `activeClientId`, and whose client is `active`. A `'client'` scope resolves to `projectIds` = every project with `client_id = activeClientId` at load time, so it covers new projects.
  - With no active client, a client account gets an empty grant list.
  - `consoleRequest(ctx, opts)` gains `client?: { id: string; projectIds: string[] }`, which builds a client `Authorisation` with `clientId` set and every grant scoped to `projectIds`.

- [ ] **Step 1: Write failing tests:**
  - `it('gives a client owner every project of the active client, including one created after the assignment')`;
  - `it('ignores assignments of another membership of the same person')`, where a person is a developer at A and finance at B, and the active client is A: `permissions()` contains `projects.credentials` and not `oversight.export`, and the scope holds A's projects only;
  - `it('gives nothing to a client account whose membership is disabled or whose client is disabled')`;
  - `it('keeps platform staff on assignments without membership')`.
- [ ] **Step 2: Run** `npx vitest run src/admin-auth/authorisation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes in `authorisation.service.ts` and `console-request.ts`, as in the Interfaces block.
- [ ] **Step 4: Run** the test, then all of `npx vitest run src/console-api`. Every existing caller passes `null` until Task 3. Expected: PASS.
- [ ] **Step 5: Commit** "Authorisation from the active client membership".

### Task 3: Sessions carry the active client

**Files:**
- Modify: `apps/api/src/admin-auth/admin-auth.service.ts`, `apps/api/src/console-api/session.guard.ts`, `apps/api/src/console-api/auth.controller.ts`
- Test: `apps/api/src/admin-auth/active-client.test.ts`

**Interfaces:**
- Consumes: `AuthorisationService.load(id, activeClientId)` from Task 2.
- Produces:
  - `SessionPrincipal` gains `kind: 'platform' | 'client'` and `activeClientId: string | null`.
  - **Sign-in.**
    - A `null` `password_hash` fails exactly like a wrong password: same message, same lockout counting.
    - A client account starts on `last_client_id` if that membership is still active, otherwise on the oldest active membership.
    - With no active membership, sign-in fails like a wrong password and records the reason `no active client`.
  - **`POST /console/auth/active-client`** takes `{ client_id }`.
    - It refuses `NOT_FOUND` unless the caller has an active membership there.
    - It sets `admin_session.active_client_id` and `administrator.last_client_id`, and returns `{ ok: true }`.
    - It is marked `@ClientAccessible()` (Task 4).
  - **`GET /console/auth/me`** gains `kind`, `active_client: { id, name } | null` and `clients: { id, name }[]` (active memberships only).

- [ ] **Step 1: Write failing tests:**
  - `signs a two-client person in on the client used last`;
  - `switches client and the next authorisation load sees only the new client's projects`;
  - `refuses to switch to a client the person does not belong to, as not found`;
  - `refuses sign-in for an invited account without a password, with the wrong-password message`.
- [ ] **Step 2: Run** `npx vitest run src/admin-auth/active-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `resolveSession` reads `active_client_id` and `administrator.kind`. `SessionGuard` passes `principal.activeClientId` to `load`.
- [ ] **Step 4: Run** `npx vitest run src/admin-auth src/console-api`. Expected: PASS.
- [ ] **Step 5: Commit** "Sessions hold the active client".

### Task 4: The wall — deny by default, approvals fixed

**Files:**
- Create: `apps/api/src/console-api/client-access.ts`
- Modify: `apps/api/src/console-api/session.guard.ts`, every console controller (decorate the allowed handlers), `apps/api/src/console-api/home.controller.ts`, `apps/api/src/console-api/approval.service.ts`
- Test: `apps/api/src/console-api/client-wall.test.ts`

**Interfaces:**
- Produces:
  - `export const CLIENT_ACCESSIBLE = 'clientAccessible'`;
  - `export const ClientAccessible = () => SetMetadata(CLIENT_ACCESSIBLE, true)`.
  - In `SessionGuard`, after the principal resolves: if `principal.kind === 'client'` and the handler is not marked, throw `new PlatformError('NOT_FOUND', 'Not found.')`.
- **Mark exactly these handlers:**
  - auth: `me`, `preferences`, `password`, `sessions`, `confirmations`, `sign-out`, `second-factor*`, `active-client`;
  - transactions: `GET transactions`, `GET transactions/export`, `GET search`, `GET transactions/:reference`, `GET previews`;
  - projects:
    - `GET /`, `POST /`, `GET :id`, `GET :id/origin-refusals`, `GET :id/deliveries`;
    - credentials: `POST`, `promote`, `DELETE`, `revoke`;
    - origins: `POST`, `DELETE`;
    - notification endpoint: `PUT`, `regenerate-secret`;
  - treasury: `GET balances`, `GET project/:projectId/accounts`;
  - the client home and team endpoints of Tasks 7 and 9.
- **Approvals, for platform staff too** (spec, audit leak 1):
  - `GET approvals` returns only requests the caller can decide or initiated;
  - `GET approvals/:id` answers `NOT_FOUND` for any other request.

  *Ruling: the spec says "require a permission". No single permission covers every approval type, so reach is "can decide or initiated", which is the same rule `decide` already applies.*

- [ ] **Step 1: Write failing tests.**
  - **`walks every console route and closes it to clients unless allowed`.** It uses `Reflect.getMetadata('path' | 'method', handler)` over `ConsoleApiModule`'s controllers. For each handler, it calls the guard's `canActivate` with a stubbed client principal, and asserts `NOT_FOUND` exactly for the handlers not in the expected allowlist, a literal array in the test. Adding a handler without updating the list fails the test.
  - `lets platform staff through unchanged`.
  - `hides approval requests the caller can neither decide nor initiated`, for both list and detail.
- [ ] **Step 2: Run** `npx vitest run src/console-api/client-wall.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the decorator and the guard check, decorate the handlers, and fix the approvals.
- [ ] **Step 4: Run** `npx vitest run src/console-api`. Expected: PASS.
- [ ] **Step 5: Commit** "Close the console to client accounts by default".

### Task 5: Project sub-resources — right permission, bound ids

**Files:**
- Modify: `apps/api/src/console-api/projects.controller.ts`, `apps/api/src/project-auth/credential.service.ts`, `apps/api/src/console-api/entitlement.service.ts`, `apps/api/src/notifications/notification.service.ts` (replay), `apps/api/src/console-api/transactions.controller.ts` (recheck/replay reach)
- Test: `apps/api/src/console-api/project-subresources.test.ts`

**Interfaces:**
- **Each sub-resource handler checks reach with its own permission**, not `projects.manage` (audit leak 8):
  - credentials use `projects.credentials`;
  - origins use `projects.origins`;
  - the notification endpoint uses `projects.notifications`;
  - entitlements use `projects.entitlements`;
  - status uses `projects.manage`.
- **Child ids are bound to `:id`** (audit leaks 6 and 7): `promote`, `delete` and `revoke` (credential), `in-flight` and `deactivate` (entitlement), and replay (delivery) look up the child with `where project_id = :id`. When it is missing → `NOT_FOUND`.
  - The credential service methods gain a `projectId` parameter: `promote(tx, projectId, credentialId, …)`, and the same for `delete` and `revoke`.
- **`transactions/:reference/recheck` and `…/replay`** check `canReachProject` on the transaction's project.

- [ ] **Step 1: Write failing tests:**
  - `a developer scoped to project A issues a credential on A without projects.manage`;
  - `refuses to revoke project B's credential through project A's URL`;
  - `refuses in-flight for project B's entitlement through project A's URL`;
  - `refuses to replay a delivery of another project`.
- [ ] **Step 2: Run** `npx vitest run src/console-api/project-subresources.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/console-api src/project-auth src/notifications`. Expected: PASS.
- [ ] **Step 5: Commit** "Project sub-resources: own permission, ids bound to the project".

### Task 6: Projects created by clients, sandbox routes, attach to a client

**Files:**
- Modify: `apps/api/src/console-api/projects.controller.ts`, `apps/api/src/config/config.ts`, `deploy/sandbox.env.example`, `apps/api/src/docs/production-env.test.ts` (if it lists refused sandbox settings)
- Create: `apps/api/src/console-api/client-projects.service.ts`
- Test: `apps/api/src/console-api/client-projects.test.ts`

**Interfaces:**
- Consumes: `req.auth.clientId` (Task 2) and `EntitlementService.grantOrAmend` (existing).
- **`POST /console/projects`:**
  - a client principal needs `projects.create_own`; `client_id` comes from `req.auth.clientId`, and any `client_id` in the body is ignored;
  - a platform principal needs `projects.manage` and may pass an optional `client_id`;
  - a duplicate code answers `FIELD_INVALID` on `code` with "That code is taken.".
- **After a client creates a project:**
  - with `SANDBOX_AUTO_ENTITLE`, in the same transaction, it grants an entitlement on every route whose current version is active and whose country is active, both directions, with the limits in Global Constraints, fees inherited and `accept_shortfall: true`;
    - `entitlement_version.created_by` is `null` and `note` is `'Opened automatically on the sandbox'`;
    - the audit records `entitlement.auto_grant` with `actorId: null`;
  - otherwise it raises an informational alert:
    - category `configuration`;
    - title `Project waiting for routes`;
    - subject reference: the project code;
    - fingerprint `project_waiting_routes:<project id>`;
    - action reference `/projects/<id>`.
- **`POST /console/projects/:id/client`**, `{ client_id }`, platform only, `admin.clients`, with a confirmation code:
  - it refuses if the project already has a client;
  - the response and the confirmation summary list the platform accounts holding a `projects` scope on it (`{ id, name }[]`).
- **Config:** `SANDBOX_AUTO_ENTITLE: z.string().optional().transform((v) => v === 'true')`, refused in production with "Invalid configuration: SANDBOX_AUTO_ENTITLE is refused in production". Set it to `true` in `deploy/sandbox.env.example`.

- [ ] **Step 1: Write failing tests:**
  - `a client owner's new project belongs to the active client and is in the owner's scope at once`;
  - `a client cannot create a project for another client through the body`;
  - `on the sandbox a client project gets every active route with the sandbox limits and inherited fees`;
  - `in production a client project gets no route and raises the waiting alert`;
  - `refuses to boot in production with SANDBOX_AUTO_ENTITLE`;
  - `attaching names the platform accounts that still reach the project`.
- [ ] **Step 2: Run** `npx vitest run src/console-api/client-projects.test.ts src/config`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** "Clients create their projects; the sandbox opens their routes".

### Task 7: Client-shaped responses and the client home

**Files:**
- Create: `apps/api/src/console-api/client-views.ts`
- Modify: `apps/api/src/console-api/transactions.controller.ts`, `projects.controller.ts`, `treasury.controller.ts`, `home.controller.ts`
- Test: `apps/api/src/console-api/client-views.test.ts`

**Interfaces:**
- **`client-views.ts`** exports pure mappers:
  - `clientTransactionDetail(platformDetail): ClientTransactionDetail`;
  - `clientProjectDetail(platformDetail): ClientProjectDetail`;
  - `clientBalances(rows): ClientBalance[]`.

  Each mapper **builds** its object from an explicit list of fields; it never spreads.
- **`ClientTransactionDetail`:**
  - reference, project_reference, project `{ id, code, name }`, direction, state, created_at, terminal_at;
  - route label fields: country, payment_method, payment_method_name, currency;
  - requested_amount, charged_amount, processing_fee, platform_fee, fee bearers, msisdn_masked;
  - failure_reason, attempts as `{ started_at, ended_at, state, failure_reason, operator_reference }[]`;
  - notifications `{ event_type, status, attempts, last_attempt_at }[]`.
- **`ClientProjectDetail`:**
  - project `{ id, code, name, status, created_at }`;
  - credentials `{ id, key, scopes, role, status, issued_at }[]`;
  - origins, notification_endpoint `{ url } | null`;
  - routes as `{ country, payment_method, payment_method_name, direction, currency, active, fees: { processing_bps, processing_fixed, processing_bearer, platform_bps, platform_fixed, platform_bearer }, limits: { minimum_amount, maximum_amount, count_24h, value_24h, count_30d, value_30d } }[]`, computed with the same `resolveTerms` and `resolveLimits` as `/v1/settings`;
  - balances;
  - `waiting_for_routes: boolean`.
- **Controllers** return the client shape when `req.auth.isClient`.
- **`GET /console/client/home`** (`@ClientAccessible()`, `transactions.read`): `{ collected_today, success_rate, undetermined }` per currency, from the existing `HomeService.collectedToday`, `overallSuccess` and `undetermined` methods, with `scope = req.auth.projectScope('transactions.read')`.

- [ ] **Step 1: Write failing tests.**
  - `client transaction detail carries none of the platform internals`. It asserts that the JSON string contains none of these keys: `provider_account`, `actual_provider_fee`, `margin`, `expected_fee_bps`, `terms`, `route_version`, `entitlement_version`, `postings`, `account_id`, `created_by`, `note`.
  - `client project routes show the client's own fees and limits, not the route base when overridden`.
  - `client home counts only the active client's projects`.
- [ ] **Step 2: Run** `npx vitest run src/console-api/client-views.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/console-api`. Expected: PASS.
- [ ] **Step 5: Commit** "Client views carry what the client is charged, nothing of ProxiaPay's".

### Task 8: Clients and memberships (platform side)

**Files:**
- Create: `apps/api/src/clients/clients.service.ts`, `apps/api/src/clients/clients.module.ts`, `apps/api/src/console-api/clients.controller.ts`
- Modify: `apps/api/src/console-api/console-api.module.ts`
- Test: `apps/api/src/clients/clients.test.ts`

**Interfaces:**
- **`ClientsService`:**
  - `createClient(tx, { name, ownerName, ownerEmail, language }, actorId): Promise<{ clientId: string }>`. It invites the owner through `InvitationService.invite` (Task 9) with profile `owner`.
  - `setClientStatus(tx, clientId, 'active' | 'disabled', actorId)`.
    - Disabling sets the active memberships to `disabled` with `disabled_by_client = true`, and revokes the sessions whose `active_client_id` is this client.
    - Re-enabling restores only the memberships with `disabled_by_client = true`.
  - `setMembershipStatus(tx, membershipId, 'active' | 'disabled', actorId)`. It refuses to disable the last active owner of an active client with `FIELD_INVALID` "A client keeps at least one active owner; invite a successor first.".
  - `disableAccount(tx, administratorId, actorId)`, platform only. It disables the administrator and revokes all their sessions.
  - `list()` and `detail(clientId)`, which give the members with profile, projects, status and invitation state.
- **Endpoints**, under `/console/oversight/clients`:
  - `GET /` and `GET /:id` (`admin.clients`);
  - `POST /` (create; `admin.clients` plus a confirmation code);
  - `POST /:id/status`, `POST /:id/owners` (invite another owner), `POST /memberships/:mid/status`, `POST /memberships/:mid/resend` and `POST /accounts/:aid/disable`, all with `admin.clients` and confirmation codes.

  Every write is audited, with the actions `client.create`, `client.status`, `membership.status`, `membership.resend` and `administrator.disable`.

- **`RoleService` guards the role kinds:**
  - `role_permissions` on a role with `kind='client'` is refused: `PERMISSION_DENIED` "Client roles are fixed.";
  - `assignment_add` refuses a client role for a platform account, and any role for a client account. Client assignments are made only by `InvitationService` and the team endpoints;
  - the roles list carries `kind`, so the console shows client roles read-only.

- [ ] **Step 1: Write failing tests:**
  - `creating a client invites its owner`;
  - `refuses to edit a client role, or to assign one through the roles page`;
  - `disabling a client disables its memberships and re-enabling restores only those`;
  - `refuses to disable the last active owner`;
  - `disabling a membership revokes only the sessions active in that client`.
- [ ] **Step 2: Run** `npx vitest run src/clients`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/clients src/console-api`. Expected: PASS. The Task 4 wall test needs no change, since these handlers are not client-accessible.
- [ ] **Step 5: Commit** "Clients and memberships for the platform".

### Task 9: Invitations and the owner's team

**Files:**
- Create: `apps/api/src/clients/invitation.service.ts`, `apps/api/src/console-api/team.controller.ts`, `apps/api/src/console-api/invitation.controller.ts`
- Test: `apps/api/src/clients/invitations.test.ts`, `apps/api/src/clients/team.test.ts`

**Interfaces:**
- **`InvitationService.invite(tx, { clientId, name, email, language, profile: 'owner' | 'developer' | 'finance', projectIds: string[] }, actorId): Promise<{ status: 'invitation_sent' }>`.** It always returns the same value.
  - **New email:** it creates an administrator with `kind='client'` and a null password, a `pending` membership, the role assignment (owner: scope `client`; developer/finance: scope `projects` with `projectIds`) and an invitation with `sets_password = true`. It then mails the link `${PUBLIC_BASE_URL}/console/invitation/<token>`. `PUBLIC_BASE_URL` is the existing config value; when it is unset the invitation is refused with a configuration error, never sent with a relative link.
  - **Existing client account:** it adds a `pending` membership and assignment, plus an invitation with `sets_password = false`, and mails "You were added to <client>'s team". If a membership already exists for this client, it changes nothing and sends nothing.
  - **Email of a platform account:** it creates nothing and sends nothing. It raises an informational security alert: title `Invitation to a platform account`, fingerprint `invite_platform:<email>`.
  - **Token:** 32 random bytes, base64url, stored as SHA-256, expiring after 72 h.
- **`InvitationService.accept(token, { password? })`.**
  - With `sets_password = true` it requires a password that passes `assertPasswordStrength`, then sets it.
  - It marks the membership `active` and the token used, and returns `{ ok: true }`.
  - An expired, used or unknown token → `FIELD_INVALID` "This invitation link is no longer valid. Ask for a new one.".
- **`GET /console/invitations/:token`** (no session) returns `{ client_name, sets_password }` or the same neutral error. **`POST /console/invitations/:token`** accepts. Neither is behind `SessionGuard`.
- **`POST /console/auth/memberships/:mid/accept`** (`@ClientAccessible()`) accepts a pending membership of the caller's own account, for the existing-account path.
- **Team**, under `/console/team`, `@ClientAccessible()` and `client.members`, always within `req.auth.clientId`:
  - `GET /` returns members `{ membership_id, name, email, profile, project_ids, status, invitation: 'pending' | 'expired' | 'accepted' }`;
  - `POST /` invites;
  - `PUT /:mid` takes `{ profile, project_ids }`;
  - `POST /:mid/status` and `POST /:mid/resend`.

  Each refuses `NOT_FOUND` when `:mid` is not a membership of the active client, and `PERMISSION_DENIED` "You cannot change your own access." when `:mid` is the caller's own. `profile` is limited to `developer` | `finance`, so an owner cannot create an owner. Every `project_ids` entry must belong to the active client (otherwise `FIELD_INVALID` on `project_ids`, "Unknown project.").
- **Mail copy** in English and French, chosen by the invitee's `language`. Subjects:
  - "Your access to the ProxiaPay console";
  - "You were added to <client>'s team on ProxiaPay".

  The body states the environment (sandbox or production) and, on the sandbox, that the code at sign-in is any six digits.
- **Audit.** Every team write and acceptance is audited, with the actions `team.invite`, `team.access`, `team.status`, `team.resend` and `invitation.accept`. The actor is the owner, or the invitee for acceptance.

- [ ] **Step 1: Write failing tests:**
  - **invitations:**
    - `new email: account without password, pending membership, one mail with a 72-hour link`;
    - `existing client account: no second account, membership pending until accepted`;
    - `platform email: same answer, nothing created or sent, alert raised`;
    - `refuses an expired, used or unknown token with one neutral message`;
    - `accepting sets the password and activates the membership`;
  - **team:**
    - `an owner cannot add a project of another client`;
    - `an owner cannot make an owner`;
    - `an owner cannot edit their own membership`;
    - `an owner cannot reach a membership of another client by id`;
    - `inviting the same address twice sends once`.
- [ ] **Step 2: Run** `npx vitest run src/clients`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the team handlers to the Task 4 allowlist array.
- [ ] **Step 4: Run** `npx vitest run src/clients src/console-api`. Expected: PASS.
- [ ] **Step 5: Commit** "Invitations by link and the owner's team".

### Task 10: Console — session, client selector, navigation, password, invitation page

**Files:**
- Modify: `apps/console/src/lib/session.tsx` (`Me` gains `kind`, `active_client` and `clients`), `apps/console/src/components/Shell.tsx`, `apps/console/src/App.tsx`, `apps/console/src/lib/i18n.ts`
- Create: `apps/console/src/pages/Account.tsx` (change password and sessions), `apps/console/src/pages/Invitation.tsx` (public, `/invitation/:token`), `apps/console/src/components/ClientSwitcher.tsx`
- Test: `apps/console/src/components/Shell.test.tsx`, `apps/console/src/pages/Invitation.test.tsx`

**Interfaces:**
- **The switcher** is shown when `me.clients.length > 1`. Selecting a client posts to `/auth/active-client`, refreshes the session and navigates to `/`.
- **Client navigation:** Home, Transactions, Projects, Team (when `has('client.members')`), plus the account link. Platform navigation is unchanged, plus an account link for everyone and an "Oversight → Clients" tab with `admin.clients`.
- **Account page:** current password, new password, confirmation. It posts to `/auth/password` and shows a success message.
- **Invitation page:** it loads `GET /invitations/:token`. It shows "Set your password" when `sets_password` is true, otherwise "Join <client>", then posts and sends the user to `/sign-in`.

- [ ] **Step 1: Write failing tests:**
  - `a client account sees Home, Transactions, Projects and Team, never Configuration, Treasury, Reconciliation or Oversight`;
  - `the switcher appears only with two clients and switching calls active-client`;
  - `the invitation page sets a password then sends to sign-in`;
  - `an invalid link shows the neutral message`.
- [ ] **Step 2: Run** `cd apps/console && npx vitest run src/components/Shell.test.tsx src/pages/Invitation.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** "Console: client sessions, switcher, account and invitation pages".

### Task 11: Console — Team page and Oversight → Clients

**Files:**
- Create: `apps/console/src/pages/Team.tsx`, `apps/console/src/pages/Clients.tsx`
- Modify: `apps/console/src/pages/Oversight.tsx` (tab), `apps/console/src/App.tsx`, `apps/console/src/lib/i18n.ts`
- Test: `apps/console/src/pages/Team.test.tsx`

**Interfaces:**
- **Team page:** a members `DataTable`, an Invite form (name, email, profile radio Developer/Finance, project checkboxes from `/projects`), and per-member actions: change access, disable/enable and resend.
- **Clients page** (platform): the list, a create form (client name, owner name, email, language), and a client detail with members, status and invite another owner. Writes use `ConfirmedAction`.

- [ ] **Step 1: Write failing tests:**
  - `invites with the chosen profile and projects`;
  - `shows the same confirmation whether or not the address existed`;
  - `does not offer the owner's own row for editing`.
- [ ] **Step 2: Run** `npx vitest run src/pages/Team.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** "Console: team management and clients".

### Task 12: Console — project page in tabs, secrets panel, client view

**Files:**
- Modify: `apps/console/src/pages/ProjectDetail.tsx` (split it; keep list factories exported where tests import them), `apps/console/src/pages/Projects.tsx`, `apps/console/src/pages/TransactionDetail.tsx`, `apps/console/src/lib/i18n.ts`
- Create: `apps/console/src/components/SecretOnce.tsx`
- Test: `apps/console/src/pages/ProjectDetail.test.tsx`, `apps/console/src/components/SecretOnce.test.tsx`

**Interfaces:**
- **Tabs**, driven by `?tab=` (the same URL-state pattern as lists): `overview`, `keys`, `origins`, `routes`, `deliveries` and `activity`. A client sees the same tabs minus `activity`.
  - `routes` shows entitlements: platform staff get today's table and grant form; a client gets the read-only `routes` from `ClientProjectDetail`.
  - When `waiting_for_routes` is true, the routes tab says "Waiting for ProxiaPay to open your routes.".
- **`SecretOnce({ items: { label: string; value: string }[]; onDismiss: () => void })`:**
  - one row per value, each with a Copy button using `navigator.clipboard.writeText`, which shows "Copied" for 2 s;
  - an "I've copied it" button that calls `onDismiss`;
  - it is rendered inside the card that produced it.

  Credential issue shows `[{ label: 'Key', value: key }, { label: 'Secret', value: secret }]`. The notification endpoint shows `[{ label: 'Signing secret', value }]`. The two never share state.
- **New project form:** the code input lowercases on change and has the hint "Lowercase letters, digits and hyphens, 2 to 32 characters.".
- **`TransactionDetail`** renders the client shape when `me.kind === 'client'`: no provider rows, no margin and no route links.

- [ ] **Step 1: Write failing tests:**
  - `issuing a credential then setting the webhook keeps both secrets, each in its own card`;
  - `copy writes the value to the clipboard`;
  - `the code field lowercases what is typed`;
  - `a client sees routes read-only and the waiting message when it has none`.
- [ ] **Step 2: Run** `npx vitest run src/pages/ProjectDetail.test.tsx src/components/SecretOnce.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** "Console: project page in tabs, secrets shown where they are made".

### Task 13: Console — every action gives feedback

**Files:**
- Modify: `apps/console/src/components/common.tsx` (`ConfirmedAction`, plus a new `SubmitForm`), `apps/console/src/lib/api.ts` (error wording), the forms in `ProjectDetail.tsx`, `Projects.tsx`, `Oversight.tsx`, `Team.tsx` and `Clients.tsx`
- Test: `apps/console/src/components/common.test.tsx`, `apps/console/src/lib/api.test.ts`

**Interfaces:**
- **`ConfirmedAction` honours `method`.** Today it always POSTs (`void method` in `common.tsx`), which breaks credential delete (`DELETE`) and administrator amend (`PATCH`). It uses `api(path, { method, body })`.
- **`SubmitForm({ onSubmit: () => Promise<string | void>, children, submitLabel })`:**
  - it disables its submit button and shows a busy label while `onSubmit` runs;
  - on success it shows `✓ <returned message>` (or `common.done`);
  - on failure it shows the readable error.

  Every plain form listed above uses it, including the entitlement grant, origin add, webhook set and project create.
- **`readableError(err: ApiError, t)` in `api.ts`.** It turns zod issue codes into field-named sentences; for example `invalid_type` with `expected: 'int'` on `processing_fee_bps` becomes "Processing bps override: a whole number of basis points (250 = 2.5 %)". It falls back to `err.message`.
- **Entitlement grant form:**
  - its limit fields start empty;
  - the fee override placeholders show the route's inherited value ("inherit: 250 bps (2.5 %)"), read from the selected route's current version (`routes.data` already carries it, or add it to `/configuration/routes` rows);
  - an empty field is sent as `null`.

- [ ] **Step 1: Write failing tests:**
  - `ConfirmedAction sends DELETE when asked`;
  - `SubmitForm disables while busy and shows the success message`;
  - `a non-integer bps is explained in words`;
  - `the grant form starts with empty limits and inherited placeholders`.
- [ ] **Step 2: Run** `npx vitest run src/components/common.test.tsx src/lib/api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** "Console: every action says it is working, then what it did".

### Task 14: Documentation and onboarding procedure

**Files:**
- Modify: `docs/shop-integration-playbook.md` (Step 1 becomes "ProxiaPay invites your owner account"), `docs/production-deployment.md` (migration 0004 and `SANDBOX_AUTO_ENTITLE`), `docs/going-live-checklist.md` (the client recreates projects, live credentials and team in production)
- Create: `docs/client-onboarding.md`, Valentine's procedure: create a client and its owner on the sandbox, what the client does, the production move, and disabling a client.

- [ ] **Step 1:** Write the docs. Run the doc tests: `cd apps/api && npx vitest run src/docs`. Expected: PASS.
- [ ] **Step 2: Commit** "Document client onboarding".

### Task 15: Whole-branch verification and local preview

- [ ] **Step 1:** Run `cd apps/api && npx vitest run` (in the background; it exceeds 10 minutes in the foreground), `npx tsc --noEmit -p .` and lint (`node ../../node_modules/eslint/bin/eslint.js src`). Then run `cd apps/console && npx vitest run && npx tsc --noEmit -p . && npm run build`. Expected: all green.
- [ ] **Step 2:** Run the console locally on a dedicated preview database, not `proxiapay_preview`, which another session uses. Show Valentine three things before any PR:
  - a client owner with two projects;
  - a member in two clients switching between them;
  - the project page in tabs, with the secrets panel and the action feedback.
