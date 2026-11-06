# Client accounts in the console

Status: design, awaiting approval · 2026-11-06

## Why

ProxiaPay is about to onboard integrators other than MonJeton. An integrator
wires the API into its own product, and needs to follow the transactions of its
projects without asking Valentine. Today the console only serves ProxiaPay's
own administrators. The 2026-11-03 home design lists "a merchant-facing
dashboard" as a non-goal; this design reverses that, deliberately.

The console already has roles, permissions and project scopes, but they were
built for staff who are trusted with the whole platform. An audit of every
console endpoint (2026-11-06) found that a project-scoped account would still
see the approval queue, platform ledger accounts, other clients' names and fee
terms on route pages, platform-wide volumes, provider costs and margins on a
transaction. So the work is in two halves: a client model, and a wall that
holds by construction rather than endpoint by endpoint.

## Who

- **Valentine (platform).** Sees and does everything, on every client. Only
  the platform creates a client and its owner account, and only the platform
  opens routes, sets limits and fees.
- **Client owner.** The account Valentine creates for an integrator, for
  example its CTO. Sees every project of their client, creates projects,
  manages credentials, webhook and origins, and invites their team.
- **Client member.** Invited by the owner, with one profile and a list of
  projects chosen by the owner:
  - **Developer:** read transactions and balances, and manage credentials,
    webhook and origins.
  - **Finance:** read transactions and balances, and export transactions as
    CSV.

## Goals

1. Valentine creates a **client** (a name) and its **owner account**, on the
   sandbox first and later, separately, in production.
2. The owner **creates projects**. The new project belongs to the owner's
   client, and the owner sees it at once, without any scope to edit.
   Members do not create projects (*my call*: the owner decides what exists).
   The owner then adds the project to members' scopes as they choose.
3. The owner **invites members**, choosing for each one a profile (Developer
   or Finance) and a subset of the client's projects. They can change both
   later, or disable the member. Disabling revokes the member's sessions.
4. Client accounts see **only their client's projects**, and only through the
   pages built for them:
   - their transactions (list, detail, search, previews, export);
   - their projects;
   - credentials, webhook and origins;
   - their own entitlements;
   - balances.
5. The client view shows **what the client is charged**: amount, fees and fee
   bearer, limits per route. It shows none of what ProxiaPay pays or earns:
   provider names, provider fees, margin, platform accounts, internal notes
   and administrator names.
6. Every **change** made by a client account is in the audit log, which only
   the platform reads: projects, credentials, webhook, origins, members and
   exports. Sign-ins are in the authentication history, as for staff. Plain
   reads are not audited, beyond the sensitive reads already audited today
   (*my call*: request-level read auditing would grow the append-only table
   for little use).
7. An account can **change its own password** from the console. Client
   accounts need this first, but every administrator gets it.

## Non-goals

- Self-signup. Every client starts with Valentine.
- Client-editable permissions. There are exactly three client roles (owner,
  Developer, Finance), fixed in code. The roles page does not offer them for
  editing.
- Clients managing their own routes, limits or fees, or suspending a project.
- Payouts, settlement statements or invoices for clients.
- Copying a client from the sandbox to production. In production, Valentine
  creates the owner again, and the client recreates its projects, live
  credentials and team there (agreed with Valentine).
- Clients reading the audit log, alerts, reconciliation, treasury floats or
  configuration.
- A view that mixes several clients. A person in two teams works in one
  client at a time.

## Anti-goals

- **A client must never see another client**, nor anything that names one or
  sums across clients: names, codes, volumes, fees or counts. A leak here
  breaks the trust the product sells. Deny by default; open by allowlist.
- **A client must never see ProxiaPay's economics**: provider cost, margin,
  platform revenue, provider identity or the float.
- **A member must never exceed the owner.** A member never holds a permission
  outside their profile, nor a project outside their client.
- No full payer numbers for any client account. Masked everywhere, and there is
  no "reveal".

## Decided by Valentine

- The client integrates on the sandbox first, then production.
- The owner creates their own projects, and manages credentials, webhook and
  origins. Routes, limits and fees stay with Valentine.
- Each client can add a team. The owner chooses each member's projects, which
  may be a subset, and what the member may do. Only Valentine sees everything.
- Two member profiles: Developer and Finance.
- Finance sees transactions and balances and exports CSV. Payer numbers are
  masked.
- Production is a fresh start: the client recreates its projects and team
  there.
- On the sandbox, the second factor accepts any six digits, as it does for
  every sandbox account today. Production requires a real TOTP.
- Accounts are created by an **invitation link** that ProxiaPay emails, not by
  a password someone else chose. This applies to the owner Valentine creates
  and to the members the owner invites.
- A person can be a member of several clients' teams. They work in **one
  client at a time**, chosen with a selector. There is never a mixed view.
- **On the sandbox, a project a client creates gets its routes
  automatically**, so the client can start testing without waiting. In
  production, Valentine still opens routes by hand.

## The shape

### Client

There is a new `client` table: id, name, status (`active` or `disabled`),
created_by, created_at.

- `project.client_id` is nullable. `null` means a platform project, as
  MonJeton is today.

Valentine can attach an existing platform project to a client. A project never
moves from one client to another.

### People and memberships (decided by Valentine)

A person can belong to several clients' teams: a freelance developer or an
accountant working for two integrators, for example.

- **An account is a person**: one email, one password and, in production, one
  TOTP. `administrator.kind` is `platform` or `client`. A platform account never
  joins a client's team, since it already sees everything.
- **A new `client_membership` table** links a client account to a client:
  administrator, client, status (`active` or `disabled`), invited_by,
  created_at. A client account has one membership per client it works for.
- **Rights belong to the membership.** Each role assignment of a client
  account names its membership, so a person can be a Developer at A on two
  projects and Finance at B on all of them.
- **One client at a time.** The session holds an active client. Every scope is
  computed from the active membership only: lists, search, exports and counts.
  A selector at the top of the console ("A ▾") switches client and reloads the
  console in the new context. With one membership the selector is not shown.
  Signing in lands on the client used last.
- **Owners see only their own team.** An owner at A cannot tell that a member
  also works for B.
- **Disabling** acts on a membership, not on the person. An owner disables a
  member of their team, which revokes the sessions whose active client is
  theirs. Valentine can also disable the whole account, which revokes all its
  sessions.

Disabling a client disables all its memberships and revokes the sessions
active in it. Its
projects keep working through the API. Suspending a project remains a separate,
existing operation. Re-enabling the client re-enables only the memberships
that the client's disabling switched off. Memberships disabled one by one stay
disabled.

**The owner's lifecycle** (*my call*):
- Ownership is the owner role's assignment, not a column on `client`.
- Valentine can invite a second owner, for example a successor, and can
  disable any membership, owner or member, one by one.
- Valentine can resend an invitation.
- An owner cannot disable another owner or change their own assignment, which
  is already the rule for staff.
- A client keeps at least one active owner while it is active. Disabling the
  last one is refused, with the hint to invite a successor first.

### Roles and scope

- The three client roles are seeded like the existing roles, and marked
  `client` so that:
  - the roles page shows them read-only;
  - they can only be assigned to client accounts, through a membership;
  - client accounts can only hold them.
- A new scope type, `client`, means "every project of the membership's
  client, including future ones". The owner's assignment uses it.
- A member's assignment uses the existing `projects` scope. Every project in
  the list must belong to the membership's client, and this is checked whenever
  the assignment is written.
- Member management uses a new permission, `client.members`, held only by the
  owner role. Profiles map to permissions as follows:

| Role | Permissions |
|---|---|
| Owner | transactions.read, projects.read, projects.create_own (new), projects.credentials, projects.origins, projects.notifications, treasury.read_balances, oversight.export, client.members (new) |
| Developer | transactions.read, projects.read, projects.credentials, projects.origins, projects.notifications, treasury.read_balances |
| Finance | transactions.read, projects.read, treasury.read_balances, oversight.export |

None of these permissions is in `SENSITIVE_PERMISSIONS`, so there is no second
approver. Operations that already take an emailed confirmation code, such as
issuing a credential, still take one.

### The wall: deny by default

The API needs a gate that does not depend on every handler remembering scope.

- **Allowlist.** A client principal reaching a console endpoint that does not
  explicitly declare itself client-accessible is refused as `NOT_FOUND`. The
  check lives in `SessionGuard`, so a new endpoint is closed to clients until
  someone opens it on purpose.
- **Client-accessible endpoints** are the auth endpoints, a client home,
  transactions (list, detail, search, previews, export), projects (list,
  create, detail, origin refusals, deliveries, credentials, origins,
  notification endpoint) and balances, plus the new member-management
  endpoints.
- **Shaped responses.** Where a platform response carries internals (see
  goal 5), the client receives a client shape built for that purpose, not the
  platform shape with fields deleted. Transaction detail, project detail
  (entitlements without base route fees, history authors or notes) and
  balances each get one.
- **Scope by the operation's own permission.** Project sub-resources check
  reach with the endpoint's own permission, not `projects.manage`
  (audit leak 8).
- **Child ids are bound to the project in the URL.** Credential, entitlement,
  origin and delivery ids are looked up within `:id` (audit leaks 6 and 7).
  This also fixes a latent cross-project bug for platform staff.
- **The approval endpoints require a permission** (audit leak 1). This is a
  platform fix in its own right; the allowlist would hide it from clients
  anyway.
- **Tests.** One contract test walks every console route registered in Nest.
  It asserts that a client principal is refused unless the route is on the
  allowlist, so the wall cannot silently regress.

### Console for client accounts

- **Navigation:** Home, Transactions, Projects, Team (owner only), and the
  account menu with "Change password". No Configuration, Treasury,
  Reconciliation, Oversight or Approvals.
- **Home:** the verdict and route chart are platform tools. A client sees
  their projects' collected-today, success rate and undetermined count, per
  currency, from the existing home service already scoped to their projects.
  Never a cross-client figure.
- **Projects:**
  - the list and the "New project" form, which sets the project's client
    server-side;
  - the project page shows credentials, webhook, origins and origin refusals,
    deliveries, and **"Routes"**: each entitled route with the client's own
    fees, fee bearer and limits, read-only;
  - balances sit on the project page, because the client has no Treasury.
  - route names are plain labels (`CM · MTN MoMo · collection · XAF`), never
    links to route pages.
- **Transactions:** as today, scoped, using the client shape for detail. The
  "Export CSV" button appears with `oversight.export`.
- **Team (owner):** members with their profile and projects. Invite (name,
  email, profile, projects), change profile or projects, disable.

### Invitations

The API already sends mail through Resend (`alerts/mailer.ts`).

- **For a new email**, an invitation creates the account with no usable
  password and a pending membership, and emails a single-use link that expires
  after 72 hours. Opening the link lets the invitee set their own password.
- **For an email that already has a client account**, no second account is
  created. The person gets an email saying they were added to the client's
  team, and the pending membership appears in their console to accept.
- **The inviting owner sees the same answer either way** ("invitation sent"),
  so they learn nothing about the address elsewhere.
- **An email held by a platform account** gets the same "invitation sent"
  answer. Nothing is sent, and Valentine gets an informational alert
  (*my call*).
- On first sign-in in production, the invitee then enrols TOTP. On the sandbox
  the second factor accepts any six digits.
- The owner can resend an expired invitation.
- The same mechanism serves Valentine creating an owner, so no one handles
  another person's password.

The existing "New administrator with an initial password" form stays for
platform staff.

### Platform side (Valentine)

- **Oversight → Clients:** a list of clients; create a client and its owner
  (invitation); disable or re-enable a client. On a client: its members, with
  disable, resend invitation and invite another owner.
- **Alert:** in production, when a client creates a project, an
  informational alert tells Valentine that a project is waiting for routes.
  Until it has routes, the client's project page says so ("Waiting for
  ProxiaPay to open your routes").
- **Project page:** the client it belongs to. Valentine can attach a
  client-less project to a client.
- **Unchanged:** routes, entitlements, limits and fees are set as today, from
  the project page.

### Automatic routes on the sandbox

- **Where it is enabled.** A new setting, `SANDBOX_AUTO_ENTITLE`, is on in the
  sandbox. Like `SANDBOX_ANY_SECOND_FACTOR`, the API refuses to boot in
  production with it on.
- **What a client project gets at creation**, in the same transaction:
  - an entitlement on every route that is active and in an active country, in
    both directions, since sandbox money is simulated (*my call*);
  - fees inherited from the route;
  - limits of 1,000 transactions and 100,000,000 per 24 h and per 30 days, the
    values used for MonJeton on the sandbox (*my call*).
- **Who it is recorded as.** The audit log records these entitlements as
  granted by the platform on the project's creation, not by the client, since
  clients hold no entitlement permission.
- **Routes opened later** on the sandbox are not added to existing client
  projects. Valentine grants them as today (*my call*: keeps the rule simple
  and visible).

## Constraints

- Same codebase and migrations for sandbox and production. A client exists
  only in the environment where it was created.
- Migration `0004`:
  - the `client` and `client_membership` tables;
  - `project.client_id` and `administrator.kind`;
  - the membership on `role_assignment`;
  - the `client` scope type and the role kind;
  - the session's active client;
  - the new permissions and the invitation tokens. No
  backfill: existing administrators and projects stay platform-side.
- `proxiapay_app` needs grants on the new tables.
- No existing account is converted. Today both environments hold only
  Valentine's platform accounts, and MonJeton stays a platform project in this
  release.
- Attaching a project to a client while a platform account holds a `projects`
  scope on it is allowed. The confirmation names those accounts so Valentine
  sees who else still reaches it (*my call*).
- Project codes stay globally unique. A taken code answers "that code is
  taken" without saying by whom. That reveals only that the code exists, which
  is accepted.

## Left to the builder

- How the allowlist is declared (a decorator on the handler is the natural
  fit) and how the contract test enumerates routes.
- The exact client response shapes, within goal 5.
- Invitation token storage (hash at rest, like sessions).
- Copy and layout of the Team page and the invitation email, in English and
  French like the rest of the console.
- Whether `projects.create_own` is a new permission or a client-only meaning
  of `projects.manage`. It must not let a client suspend a project or create a
  platform project.

## Also shipping in the same release (Valentine's earlier feedback)

- **Secrets shown once:**
  - each secret appears in the card that produced it: credentials or
    notification endpoint;
  - each value is labelled (key, secret, signing secret) and has a Copy
    button;
  - the panel stays until "I've copied it" is clicked.

  Today a single shared panel lets the webhook secret be overwritten by the
  credential's.
- **Project code field:** lowercases as you type, with a hint under it
  ("lowercase letters, digits and hyphens, 2 to 32 characters").
- **Entitlement form:**
  - the fee override fields show the inherited value as their placeholder, for
    example "inherit: 250 bps (2.5 %)", so an empty field is not mistaken for
    0;
  - the limit fields start empty instead of being pre-filled with someone
    else's numbers.
- **Every console action gives feedback** (Valentine, 2026-11-06). Today
  adding an entitlement shows neither a loader nor a success message, and six
  identical MOMO entitlement versions were created in one minute in production
  as a result. Every form and action button:
  - is disabled while its request runs, and shows that it is working;
  - says what it did when it succeeds;
  - says what went wrong in plain words when it fails. A validation error
    names the field and the expected format, never "expected int, received
    number".
- **The project page is split into tabs** (Valentine, 2026-11-06) instead of
  one long page:
  - Overview: status, balances, client;
  - Keys & webhook;
  - Origins, with refusals;
  - Routes: entitlements;
  - Deliveries;
  - Activity.

  A client account sees the same tabs, minus what it cannot reach.
