# Onboarding a client

Valentine's procedure for giving a client its own account: its own console, its
own projects, its own team, and no sight of providers or margins. A client exists
only in the environment where it was created, so the sandbox comes first and
production is a second, separate pass.

You need the `admin.clients` permission. The sandbox needs `PUBLIC_BASE_URL` and
`SANDBOX_AUTO_ENTITLE=true` (`docs/sandbox-deployment.md`).

## 1. Create the client on the sandbox

1. Console, **Oversight, Clients**. Fill in **Client**, **Owner name** and
   **Owner email**, then **Create client**. It asks for an emailed confirmation
   code.
2. The owner receives an email with a link,
   `https://sandbox.pay.proxia-digital.com/invitation/<token>`. It is valid for 72
   hours and works once. You never see or choose their password.
3. If it expires, open the client and use **Resend invitation** on the owner.

"Invitation sent." is not proof that the address exists or that the mail arrived:
the console answers the same way whatever happens to the address. Check with the
owner that the email came.

On the sandbox the second factor accepts any six digits and never asks to enrol an
authenticator. Production needs a real TOTP.

## 2. What the owner does

- Opens the link, sets a password, signs in.
- **Creates projects** (**Projects**, **New project**). On the sandbox each new project
  gets every active route, in both directions, at once: 1000 transactions and
  100 000 000 per 24 hours and per 30 days, fees inherited. Routes opened after
  that are not added to existing projects; grant them from the project page.
- **Issues credentials** on the project (`pk_test_…` / `sk_test_…`, shown once,
  with an emailed code).
- **Sets the notification address**, and keeps the signing secret. An address
  inside a network (localhost, a private or link-local IP, a name that resolves to
  one, a single-label, `.internal` or `.local` name), or a name that does not
  resolve, is refused: "That address is not reachable from the internet." Redirects
  from it are not followed.
- **Invites the team** (Team): Developer or Finance, with the projects each can
  reach. A member signs in with the same link and password steps.
- With several clients on one account, switches between them in the console. One
  is active at a time.

- **Sets the project's brand** (the project page): a logo (PNG, JPEG or WebP, at most
  200 KB, no SVG), a primary colour and an optional secondary colour. A colour whose
  contrast with white text is below 4.5:1 is refused. The payment page, the receipt and
  the receipt email carry this brand; ProxiaPay appears only as "Powered by ProxiaPay".
- **Creates payment links** (the project's **Payment links** tab): a shareable address,
  `<PAYLINK_BASE_URL>/<code>`, where a payer pays without a credential. A link starts from
  the project's brand and can change it at creation. It offers only routes the payer can
  complete without typing a code. The tab shows each link's count, total collected and
  last payment; its payments appear in the transaction list, filterable by link.

The client then follows `docs/shop-integration-playbook.md`.

## 3. Attach an existing project to a client

For a project that already exists, such as MonJeton's: open the project page, and
in the **Attach to a client** card choose the client, then **Attach to client**. The
confirmation names any platform account that
still holds a `projects` scope on it, so you see who else reaches it. Routes,
entitlements, limits and fees stay yours to set from the project page, as before.

## 4. Move to production

Nothing carries over from the sandbox.

1. In production, **Oversight, Clients**: create the client and its owner again.
   The owner accepts the production link and **enrols an authenticator** at first
   sign-in.
2. The owner recreates the projects, issues live credentials (`pk_live_…` /
   `sk_live_…`), sets the notification address, declares the IP addresses and
   invites the team.
3. Each new project raises an informational alert, **Project waiting for routes**.
   Open the project and grant its entitlements by hand: routes, limits, fees.
   Until then the owner's project page reads "Waiting for ProxiaPay to open your
   routes". `SANDBOX_AUTO_ENTITLE` is never set in production.
4. Go through `docs/going-live-checklist.md` with the client.

## 5. Disabling

- **A client** (Oversight, Clients, **Disable client**): every membership is
  switched off with it, so nobody on the team can sign in to it. Re-enabling
  restores only the memberships the disabling switched off; those disabled one by
  one stay disabled.
- **A member** (on the client, or the owner on the Team page): **Disable**. The
  last active owner of an active client cannot be disabled: invite a successor
  first (**Invite another owner**).
- **An account** (**Disable account**): the person can no longer sign in anywhere,
  whatever clients they belong to. **Enable account** on the same row lets them
  back in; memberships keep their own status. A client account is managed here
  only: the administrators page refuses to change its status.

## 6. What a client never sees

- Provider names or account ids, provider fees, binding snapshots.
- Margin and platform revenue, ledger accounts.
- Payer numbers in clear: always masked, no client role can read identifiers.
- Route or entitlement version history, internal notes, who on the platform did
  what.
- Another client's projects, transactions or figures. Any console page outside its
  own (Configuration, Treasury, Reconciliation, Oversight, Approvals) answers
  "Not found.", as if it did not exist.

It does see, on each project, the routes it holds as plain labels, with its own
fees, who bears them, and its limits.
