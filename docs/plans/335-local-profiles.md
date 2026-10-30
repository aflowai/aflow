# Plan 335 — Local profiles: several people share one install

**Status:** 🚧 P1 built under option A (§11). P2 to P5 are not built. This document reads the code as it stood, judges three shapes for a profile and proposes phases.

**Builds on:** Plan 315 (the local edition's first run), Plan 330 (the first space a fresh install gets), Plan 334 (the first-run card in the empty chat).

**Leaves alone:** the hosted edition's identity plane, its invitations and its tenant membership flow. This document cites them as the model a local profile can copy. It changes none of them.

## 1. Problem

The local edition has one person in it. Every request from the browser is the same owner. Every space, conversation, memory and key belongs to that owner. A household or a small team that shares one computer cannot keep their work apart.

The operator's direction, 2026-10-30: start thinking about local profiles, the way Netflix accounts let several people share one device. Use the tenant setup if it fits. Model the UX on how Netflix and HBO manage profiles. Later, a profile may connect to an aflow.ai account for online, social and comms features.

This round answers three questions:

- What is a profile in Aflow terms?
- What does a profile isolate, and what do profiles share?
- What must the local design leave room for, so that an aflow.ai account can attach later?

## 2. What the code shows today

Read at `513e7104`. Every fact names the file it was read from.

### 2.1 The local edition's identity

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **The local edition is one tenant and one owner, by design.** `EditionIdSchema` describes `community-local` as "Single-user local appliance: one fixed tenant, one local owner" (`packages/schemas/src/edition/descriptor.ts:19-24`). It resolves to `authProvider: 'local-instance'` and `tenancy: { mode: 'fixed', tenantId }` (same file, the `community-local` branch of `resolveEditionDescriptor`).                                                                                                                                                                                                                                                |
| F2  | **The tenant and the owner have well-known ids.** `LOCAL_EDITION_TENANT_ID` ends in `ed1c0` and `LOCAL_EDITION_OWNER_ID` ends in `ed1c1` (`descriptor.ts:214`, `:222`). `PHOENIX_LOCAL_TENANT_ID` and `PHOENIX_LOCAL_OWNER_ID` override them. `instance.env` records both, because a backup carries nothing else that names them (`packages/server-runtime/src/bootstrap/instanceConfig.ts:1-31`, `MANAGED`). The same file holds the instance secret, and its header says "leaking it is granting owner access".                                                                                                                                        |
| F3  | **Who the user is on a fresh install.** `bootstrapLocalEdition` runs before the API serves anything (`apps/server/src/bootstrapLocal.ts:93`). It writes the tenant row named `Local` (`packages/server-runtime/src/bootstrap/localEdition.ts:83-88`) and creates the tenant schema (`:91-98`). It inserts the owner into `public.users` with the display name `Local user` and no email (`:101-106`, default at `:66`). It gives the owner an `owner` tenant membership (`:109-122`).                                                                                                                                                                    |
| F4  | **The first space.** Bootstrap claims the space the tenant schema seeds, or creates `Personal` when none is left (`localEdition.ts:35`, `:127-183`). It sets the tenant's default space (`:190-207`). It gives the owner an `admin` space membership (`:209-225`) and assigns the default capability profile (`:228-255`).                                                                                                                                                                                                                                                                                                                               |
| F5  | **There is no login.** The web process holds `PHOENIX_INSTANCE_SECRET` and attaches it to every call it forwards (`apps/web-local/src/compose/localWebIdentity.ts:30-43`). Admission is reachability: a request under a host or origin this instance does not answer to is refused (`localWebIdentity.ts:54-70`, `apps/web-local/src/proxy.ts:36-50`). In the file's words, "being admitted is being the owner" (`localWebIdentity.ts:72-79`).                                                                                                                                                                                                           |
| F6  | **The API maps the secret to the owner.** `authenticateLocalInstance` compares the bearer token with the instance secret and returns `localOwner()` on a match (`packages/server-runtime/src/plugins/localInstanceAuth.ts:121-138`). `localOwner()` is a fixed user with `authMethod: 'local'` and the display name `Local user` (`:103-111`). A token with the API-key prefix goes to the key path instead (`:136`).                                                                                                                                                                                                                                    |
| F7  | **The tenant plugin grants the owner role without a lookup.** Under fixed tenancy, a request naming another tenant is refused (`packages/server-runtime/src/plugins/tenant.ts:282-299`). An `authMethod: 'local'` request is `owner` with no membership read (`tenant.ts:319-324`). Any other principal needs an active `tenant_memberships` row (`tenant.ts:332-339`).                                                                                                                                                                                                                                                                                  |
| F8  | **The first-run path in `apps/web-local`.** The front door enters `/chat` in the preferred space (`apps/web-local/src/app/page.tsx:13-21`). The preferred space is a cookie hint (`packages/web-product/src/ui/lib/preferredSpace-actions.ts:4-22`). The dashboard wraps the shared `DashboardShell` with nothing else, because "this edition has no account to admit" (`apps/web-local/src/app/(dashboard)/layout.tsx:4-13`). `SpaceGate` shows `OnboardingFlow` when there is no space and a picker when no space is active. On a fresh local install it resumes the provider setup (`packages/web-product/src/ui/components/space-gate.tsx:217-242`). |
| F9  | **A failed credential has no login page to send anyone to.** The local recovery policy shows a message instead (`apps/web-local/src/components/local-providers.tsx:15-30`). **Sign out** renders in the hosted edition only (`packages/web-product/src/ui/components/app-shell.tsx:446-456`).                                                                                                                                                                                                                                                                                                                                                            |
| F10 | **The account entry sits in the sidebar footer. The code has no top bar.** The avatar and display name open `/account` (`app-shell.tsx:386-424`). `/account/profile` edits the display name through `PATCH /users/me` and shows the email read-only (`packages/web-product/src/ui/screens/account-profile.tsx:40-47`, `:88-99`). The label falls back to the email, then to `User` (`app-shell.tsx:102`).                                                                                                                                                                                                                                                |

### 2.2 Users, tenants and schema-per-tenant

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F11 | **`packages/database/src/tenant.ts` is one line.** It re-exports `./tenant/index.js`. The schema lifecycle is in `packages/database/src/tenant/schemaManagement.ts`. The naming is in `packages/database/src/tenant/context.ts`.                                                                                                                                                                                                                                                                                                                                          |
| F12 | **One Postgres schema per tenant.** `tenantIdToSchemaName` maps a tenant UUID to `t_<32 hex>` (`tenant/context.ts:16-27`). `createTenantSchema` creates the schema and applies the tenant migrations (`tenant/schemaManagement.ts:20-33`). `dropTenantSchema` drops it with `CASCADE` (`:39-53`).                                                                                                                                                                                                                                                                         |
| F13 | **Identity lives in `public`, shared by every tenant.** `users` holds `display_name`, a nullable `email`, `avatar_url`, `kind`, `status` and `metadata` (`packages/database/src/schema/public.ts:191-221`). `user_identities` links an external identity to a user by `provider` and `provider_sub` (`:232-258`). `tenant_memberships` joins a user to a tenant with a role (`:269-300`). `space_memberships` joins a user to a space as `admin`, `editor` or `viewer` (`:312-337`).                                                                                      |
| F14 | **Roles.** Tenant roles are `owner`, `admin`, `member`, `viewer` and `billing`. Space roles are `admin`, `editor` and `viewer` (`packages/schemas/src/identity/user.ts:26-29`).                                                                                                                                                                                                                                                                                                                                                                                           |
| F15 | **A tenant admin does not read a space they are not a member of.** `GET /v1/spaces` lists every space for a tenant admin. A space without the caller's membership comes back as a redacted metadata row with `myRole: null` (`packages/server-runtime/src/routes/spaceCrudRoutes.ts:210-216`, `:254-275`). `GET /v1/spaces/by-slug/:slug` does the same (`:415-450`). The client renders such a space as not found (`packages/web-product/src/ui/components/space-access-gate.tsx:7-22`). A non-admin sees only the spaces they belong to (`spaceCrudRoutes.ts:210-216`). |
| F16 | **Erasing one user is already a function.** `accountCascade.ts` purges the spaces a user is alone in. It hands shared spaces to a successor and clears authorship elsewhere (`packages/database/src/tenant/accountCascade.ts:10-24`).                                                                                                                                                                                                                                                                                                                                     |

### 2.3 The `@phoenix.local` identities

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F17 | **`dev@phoenix.local` is the development bypass user, not the local owner.** `DEV_USER_ID` is `…0001` (`packages/server-runtime/src/plugins/auth.ts:65`). `ensureDevUser` upserts it with that email and an `owner` membership in `DEFAULT_TENANT_ID` (`auth.ts:733-782`). A request with no header gets it, with the email marked verified (`auth.ts:817-838`).                  |
| F18 | **The bypass never opens in the local edition.** `allowDevBypass` requires `!isLocalInstance` (`auth.ts:226-229`). The local branch of `authenticate` runs first and returns (`auth.ts:796-814`). The local owner has no email at all (F3, F6).                                                                                                                                   |
| F19 | **A `.local` address is one that can never receive mail.** `isUndeliverableAddress` refuses reserved names and mDNS `.local` (`packages/schemas/src/identity/inviteRequest.ts:64-73`). Its test lists `dev@phoenix.local` among them (`packages/schemas/src/__tests__/inviteRequest.test.ts:19`). `CLAUDE.md` keeps the name on purpose, as one of the places "phoenix" survives. |

### 2.4 Spaces, credentials, keys and the host lane

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F20 | **A space is the isolation boundary for content.** Spaces live in the tenant schema. Their `owner_id` "holds an irremovable admin membership row" (`packages/database/src/schema/tenant/spaces.ts:15-52`). Memory documents and directories require a `space_id`, and `user_id` is an optional refinement (`packages/database/src/schema/tenant/memory.ts:120-122`, `:280-282`). Sessions carry `space_id` and `created_by` (`packages/database/src/schema/tenant/sessions.ts:63`, `:92`).              |
| F21 | **Model keys resolve user first, then space, then tenant.** `provider_credentials` has a `scope` of `user`, `space` or `tenant` (`packages/database/src/schema/tenant/integrations.ts:178-226`). `CredentialResolver.resolve` walks that chain (`packages/credential-resolver/src/resolver.ts:53-63`). The user in the chain is the run's creator (`apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/startRun.ts:639`, `scheduling/scheduleStep.ts:726`, `scheduling/timers.ts:772`). |
| F22 | **Integration API credentials are per space.** `api_credentials` is keyed by credential key and `space_id` (`integrations.ts:139-164`).                                                                                                                                                                                                                                                                                                                                                                 |
| F23 | **API keys belong to a user and carry that user's whole authority.** `POST /v1/api-keys` binds the key to the caller and the tenant with empty `scopes`, because "nothing in authorization reads a key's scopes" (`packages/server-runtime/src/routes/api-keys.ts:25-35`, `:67-69`). The list shows only the caller's keys (`api-keys.ts:152`). Creating one needs `tenant` `write` (`api-keys.ts:50`).                                                                                                 |
| F24 | **`mcp.local.json` holds an owner key.** `yarn mcp:setup` mints the key with the instance secret, so the key belongs to the owner (`scripts/mcp-local-setup.mjs:368-385`). The file carries `apiKey`, `tenantId` and `sessionToken`. It carries `user` only where the owner has an email (`mcp-local-setup.mjs:264-267`, `apps/aflow-mcp/mcp.local.json.example`).                                                                                                                                      |
| F25 | **One paired machine per install.** `pair` writes one `host.env` with the host lane's Redis credential (`apps/aflow-executor-host/src/pair.ts:103-108`). The host lane is present where `PHOENIX_HOST_REDIS_PASSWORD` is set (`descriptor.ts`, `hostLaneComposed`). A folder binding is space-scoped (`packages/database/src/schema/tenant/hostBindings.ts:16-36`). The machine's own policy file must also offer the folder.                                                                           |
| F26 | **Store installs are per space.** `store_installs` carries `space_id` (`packages/database/src/schema/tenant/storeInstalls.ts:15-22`).                                                                                                                                                                                                                                                                                                                                                                   |
| F27 | **Spend is recorded per session, not per person.** `sessions.total_cost_cents` sits beside `created_by` (`sessions.ts:63`, `:86`). No per-user budget exists in the schema.                                                                                                                                                                                                                                                                                                                             |
| F28 | **Under fixed tenancy every new space gets the admin capability default.** `defaultsToSafeProfile` returns false whenever tenancy is `fixed` (`packages/schemas/src/edition/spaceCapabilityDefault.ts:18-23`). The tenant capability ceiling is tenant-wide, and `tenant_capability_grants` pierces it per user (`public.ts:85-91`, `:104-120`). Nothing narrows one user below the tenant.                                                                                                             |

### 2.5 What the hosted edition has, and the seam between the editions

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F29 | **Auth0 and JIT admission.** In the hosted edition a JWT's subject resolves to a user through `user_identities` (`auth.ts:1-17`). An unknown subject is provisioned on first login. A pending invite for any tenant admits it, and otherwise the tenant's signup policy decides (`auth.ts:355-440`, `packages/server-runtime/src/lib/signupAdmission.ts:1-28`).                                                                                                                                                                            |
| F30 | **Invitations and space shares.** `invites` holds a pending invite per tenant and email, with a role and a token hash (`public.ts:347-381`). `space_grants` holds a pending share of one space, redeemed against the verified email at admission (`public.ts:386-419`). Plan 256's text is in the unpublished archive (`docs/plans/README.md`, "The earlier archive is not published"). This document reads the code only.                                                                                                                 |
| F31 | **The local edition refuses identity-provider configuration.** `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` and `AUTH0_CLIENT_ID` are a violation under `community-local` (`descriptor.ts`, `ENTERPRISE_IDENTITY_ENV_KEYS` and the `community-local` branch of `resolveEditionDescriptor`).                                                                                                                                                                                                                                                            |
| F32 | **The local web withholds the membership surfaces.** The settings tabs **Members**, **Invites** and **Spaces** need the `tenant-members`, `invites` and `space-members` surfaces (`packages/web-product/src/ui/components/tenant-settings/tabs.ts:8-12`). The core composition registers none of them (`packages/server-runtime/src/compose/coreSurfaces.ts`). `settings/spaces` is a hosted-only route (`packages/web-product/src/ui/routeManifest.ts:82-90`). **People** in the sidebar needs `space-members` (`app-shell.tsx:347-361`). |
| F33 | **The edition seam is the ownership manifest.** `apps/web-local/` and `apps/aflow-executor-host/` are `local` (`packages/schemas/src/edition/ownership.ts:112-121`). `apps/web/`, `apps/server-hosted/` and `packages/auth0-management/` are `cloud` (`ownership.ts:97`, `:146-160`). `packages/database/`, `packages/web-product/` and `packages/server-runtime/` are `core` (`ownership.ts:63-90`). This checkout is the public cut, so the cloud paths are absent.                                                                      |
| F34 | **The local edition promises no account.** The privacy help article says Aflow Local "needs no account and checks no licence" (`packages/platform-artifacts/src/helpCenter/articles/privacy.ts:9`, `:18`).                                                                                                                                                                                                                                                                                                                                 |

### 2.6 What the facts add up to

The data model already has several users in one tenant. Memberships, space roles, user-scoped keys, redacted admin views and account erasure are all in `core`. The hosted edition fills them through Auth0 and invitations. The local edition fills them with one row, and its web process can only ever say "the owner" (F5, F6, F7).

So a profile does not need a new data model. It needs a way for the local web process to say which user is at the keyboard.

## 3. What is a profile? Three options

Each option is judged on the same rows. "Isolated" means another profile cannot read or spend it. "Shared" means every profile reaches the same thing.

### Option A — A profile is a user inside the install's one tenant

A profile is a row in `public.users` with an active `tenant_memberships` row in the pinned tenant. The owner from bootstrap is the first profile. A new profile gets a `member` role and a first space of its own, made by the same steps bootstrap uses (F4).

| Concern           | Under option A                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spaces            | **Isolated.** A member sees only the spaces it belongs to (F15). The owner sees other profiles' spaces as names only, with no content (F15).                               |
| Memory            | **Isolated** by space (F20).                                                                                                                                               |
| History           | **Isolated** by space. Sessions also record `created_by` (F20).                                                                                                            |
| Credentials       | **Isolated where the profile stores them at user scope.** A tenant-scoped key stays shared (F21). Integration credentials are per space (F22).                             |
| API keys          | **Isolated.** A key belongs to one user and lists only for that user (F23).                                                                                                |
| Model spend       | **Attributable** per profile through `sessions.created_by`. Not capped, because no per-user budget exists (F27).                                                           |
| Shared on purpose | The paired machine and its host lane (F25). The tenant's model keys (F21). The Store catalog. The tenant settings and the model allowlist. A space that two profiles join. |
| Cost              | The local web and the API learn to carry a chosen user (§3.4). The owner's tenant-wide view must stay redacted. Profile management routes and screens are new.             |

### Option B — A tenant per profile

Each profile gets its own tenant row and its own Postgres schema (F12).

| Concern                 | Under option B                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spaces, memory, history | **Isolated** by schema. This is the strongest separation of the three.                                                                                                                                                                                                       |
| Credentials, keys       | **Isolated**, tenant-scoped model keys included. Each profile enters its own model keys again.                                                                                                                                                                               |
| Model spend             | **Isolated** per tenant.                                                                                                                                                                                                                                                     |
| Shared                  | The paired machine only. Nothing can be shared on purpose, because a space cannot cross tenants.                                                                                                                                                                             |
| Cost                    | The edition pins one tenant per process and refuses any other (F1, F7). Bootstrap provisions exactly one (`localEdition.ts:68-75`). `instance.env` and every backup name one tenant (F2). A profile switch would need a multi-tenant local edition, or a restart per switch. |

The cost lands on the edition's core decision, a fixed tenant. The gain is one the household case does not need. A household wants to share a space sometimes, and option B forbids it.

### Option C — A local-only profile layer in front of one user

A new table holds a name, an avatar and a PIN. Every request stays the owner. The web filters which spaces each profile sees.

| Concern                 | Under option C                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spaces, memory, history | **Hidden in the web only.** The API still answers every call as the owner (F6). An agent run by one profile reads every space the owner reaches.                                          |
| Credentials, keys       | **Shared.** User-scoped keys resolve to the one owner (F21). API keys all belong to the owner (F23).                                                                                      |
| Model spend             | **Not attributable.** Every session's `created_by` is the owner.                                                                                                                          |
| Shared                  | Everything.                                                                                                                                                                               |
| Cost                    | Low now. But it is a second identity concept beside `users`. An aflow.ai account would later attach to something that is not a user. Moving off it later is a clean cut that discards it. |

Option C looks like profiles and isolates nothing. It also has no answer to §5.

### 3.4 What option A changes, in outline

This is the shape only. P1 designs it in full.

- **The web says which profile.** After a profile is chosen, the browser holds an opaque profile session in an `httpOnly` cookie. The web process forwards it beside the instance secret.
- **The API maps the session to a user.** `authenticateLocalInstance` returns the owner today (F6). With a valid profile session it returns that profile's user instead, still with `authMethod: 'local'`. A missing session keeps today's answer, the owner. **That answer defeats the per-profile PIN of D3 at a shared browser.** A person who clears the cookie or opens a private window skips the picker and acts as the owner. The owner's own PIN then guards nothing. Every other PIN falls too, because the owner resets a forgotten PIN (D3). The code as it stands forces this answer. The web process attaches the instance secret to every call it forwards and reads no session (`apps/web-local/src/compose/localWebIdentity.ts:30-43`). The API makes the secret the owner with nothing else to read (`localInstanceAuth.ts:134-135`). `yarn mcp:setup` calls the API with the bare secret too (`scripts/mcp-local-setup.mjs:368`, `:379`). This outline does not settle what a missing session should mean. §8 question 7 carries it.
- **The tenant plugin reads the membership.** The shortcut at `tenant.ts:319-324` applies to the owner only. Every other profile reads its `tenant_memberships` row, as a hosted user does (F7).
- **Nothing in the run path changes.** Runs already carry their creator, and keys already resolve user first (F21).

The trust stays as it is. The web process holds the instance secret, which is already the owner's whole authority (F2, F5). Naming a lesser user with it grants nothing new.

## 4. The UX, modelled on Netflix and HBO

Netflix and HBO Max share one pattern. A "Who's watching?" grid of avatars opens the app. A tile adds a profile. **Manage profiles** edits the name, the avatar, the lock and the restrictions. The avatar menu switches profile. A kids profile is a simpler, restricted place, and leaving it can need a PIN.

### D1 — Who is using Aflow: the choice at session start

- The front door (`apps/web-local/src/app/page.tsx`) shows **Who is using Aflow?** when the install has two or more profiles and the browser holds no profile session. It shows one tile per profile. The owner also sees an **Add profile** tile.
- An install with one profile shows no picker. A fresh install looks and behaves as it does now (F3, F8). The picker appears once a second profile exists.
- Choosing a tile starts the profile session and enters that profile's preferred space. The preferred-space cookie becomes per profile (F8).
- The session lasts until the person switches profile or the browser clears it. An idle timeout is an open question (§8).

### D2 — Switch profile, add profile, avatar and name

- **Switch.** The avatar in the sidebar footer opens a menu instead of going straight to `/account` (F10). The menu lists the other profiles, **Manage profiles** and **Account settings**. The code has no top bar, so the footer is where this lives.
- **Add.** The owner adds a profile with a name and an avatar. The new profile gets a first space called `Personal` and an admin membership in it, through the same steps as bootstrap (F4).
- **Avatar.** A small set of built-in avatars, stored as a key in `users.avatar_url` (F13). No upload in the first cut.
- **Name.** `users.display_name`, edited where it is edited now (F10).
- **Remove.** The owner removes a profile through `accountCascade.ts` (F16), behind a confirmation that names what is lost. Nobody can remove the owner profile.

### D3 — An optional PIN per profile

- A profile may set a PIN of four to six digits. The picker asks for it before it starts that profile's session.
- The API checks the PIN and issues the session. The web does not decide it.
- The PIN keeps one person at a shared browser out of another's profile. **This promise is conditional.** It holds only once a request with no profile session stops acting as the owner, and that needs later work (§3.4, §8 question 7). It is not a boundary against someone with the operator's OS account. That person can read `instance.env`, which holds the owner's authority (F2). The settings page says so in one sentence.
- The owner resets a forgotten PIN.

### D4 — A restricted profile: a question, not a commitment

A kids-style profile is easy to draw and hard to define here. The questions:

- **What does it restrict?** Candidates are the host lane, the browser lane, sandboxed code, web search and spend. Each is a different control in the code today.
- **Where does the restriction live?** The tenant ceiling is tenant-wide and only pierced per user (F28). A restricted profile needs the opposite, a per-user floor. That is a new rule in capability resolution.
- **Does it filter model output?** Nothing in the code does that today.
- **Does it cap spend?** No per-user budget exists (F27).
- **How does a person leave the restricted profile?** HBO asks for the owner's PIN. That needs D3 first.

This document builds none of it. P5 exists only if the operator answers these questions.

### D5 — Where it lives in the local app

| Place               | What appears                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| First run           | Nothing new. The owner is the only profile. The provider setup and the first-run card run as today (F8, Plan 334).              |
| Front door          | **Who is using Aflow?** once a second profile exists (D1).                                                                      |
| Sidebar footer      | The avatar menu with **Switch profile** and **Manage profiles** (D2).                                                           |
| Settings → Profiles | The owner's list: add, rename, avatar, PIN reset, remove. Local edition only, gated on the edition and never on a surface name. |
| `/account/profile`  | The current profile's own name, avatar and PIN.                                                                                 |
| Help                | A help article on profiles. The privacy article is read again for the word "account" (F34).                                     |

### D6 — One word in the UI, none new in the code

The UI says **profile**. The code says **user**, because a profile is a `users` row. The UI word collides with the capability profiles under **Access Control** and with the browser profiles of Plan 320. A screen that shows both says **capability profile** for the first.

## 5. The later aflow.ai account seam

Sign-in, social and comms features come later, under a plan of their own. Nothing here builds them. The local design leaves room for them in these ways:

- **A profile is a user row with a stable UUID.** A later link is one `user_identities` row with a provider such as `aflow.ai` and the account's subject (F13). No profile table needs to change.
- **A profile has no invented email.** `users.email` stays null until a linked account supplies one (F13). No profile gets a `@phoenix.local` address, which the code already treats as undeliverable (F19).
- **The avatar is replaceable.** A built-in avatar key in `avatar_url` can later give way to the account's picture. The hosted edition already syncs one from its provider (`auth.ts:336-352`).
- **Local access never depends on the account.** Choosing a profile works offline and with no account. The privacy article's promise holds (F34).
- **The link is not the hosted login.** The local edition refuses Auth0 configuration (F31). A link is an outbound connection that a profile makes. It is not a gate in front of the install.
- **The local tenant stays local.** A linked account belongs to a hosted tenant. The two are never merged. Linking alone uploads nothing.
- **Each feature that leaves the machine is the profile's own opt-in.** Linking a profile shares nothing by itself.

## 6. What it affects

Under option A, if the phases below are approved:

- `packages/server-runtime/src/plugins/localInstanceAuth.ts` and `plugins/tenant.ts` carry the profile session and the owner-only shortcut (§3.4).
- `packages/server-runtime/src/bootstrap/localEdition.ts` has its first-space steps reused for a new profile.
- A new `core` route group for local profiles refuses every edition but the local one.
- A stored profile session and a PIN hash sit in `public`, beside the user.
- `apps/web-local/src/compose/localWebIdentity.ts`, its proxy and the front door forward the profile session.
- `packages/web-product` gains the picker, the footer menu, Settings → Profiles and the help article.
- The run path, the executors, the hosted edition and `mcp.local.json` do not change.

## 7. Recommendation

**Choose option A. A profile is a user inside the install's one tenant.**

The reasons:

1. **It uses what is built.** Users, memberships, space roles, redacted admin views, user-scoped keys and account erasure are all `core` (F13–F16, F21, F23).
2. **It isolates what matters.** Spaces, memory, history and spend attribution separate with no new rule in the run path. Keys separate too, wherever a profile may hold them. Whether a non-owner profile may create API keys stays open (§8 question 4).
3. **It shares what a household shares.** One machine, one set of model keys at tenant scope, and a space two profiles join on purpose.
4. **It keeps the edition's core decision.** One tenant stays pinned, and backups stay as they are (F2).
5. **It is the seam §5 needs.** An aflow.ai account later links to a user, as an Auth0 identity does in the hosted edition.

Option B is rejected because it breaks fixed tenancy and forbids sharing. Option C is rejected because it isolates nothing and leaves the account seam with no user to attach to.

### Not built, on purpose

- Any aflow.ai sign-in, link, social or comms feature.
- A restricted profile, until the operator answers D4.
- Per-profile spend caps.
- Invitations, email shares, or the hosted **Members** and **Invites** screens in the local edition.
- A profile boundary against someone with the operator's OS account. The PIN does not claim one.
- A tenant per profile.
- A picker on an install with one profile.
- Per-profile MCP files. `mcp.local.json` stays the owner's. Whether a profile may mint its own key under Settings → API Keys is left open in §8 question 4.

## 8. Open questions

1. Does the owner see other profiles' space names in the switcher, as a tenant admin does today (F15)? The alternative is a list filtered to the owner's own spaces in the local edition.
2. Do profiles other than the owner hold `member` or `admin`? An `admin` sees every space name and can change tenant settings.
3. Should a profile session end after idle time?
4. May a non-owner profile create API keys? Today that needs `tenant` `write` (F23). Where a profile may hold keys, they are its own (§7 reason 2).
5. Which model keys does a new profile get: the tenant's, its own, or a choice at creation?
6. Who may pair the machine and bind folders in a profile's space? The machine is one and shared (F25).
7. What does a request with no profile session mean once a second profile exists? Today it is the owner, and that defeats every PIN at a shared browser (§3.4, D3). Callers such as `yarn mcp:setup` hold the bare secret and expect the owner (F24). The answer decides whether D3's promise can hold.

## 9. Phases — proposed, pending the operator's choice

**P0 — This document and its index row.** _Exit:_ the operator chooses an option and answers §8, or amends them.

**P1 — The API serves more than one local user.** The profile session, the change to `authenticateLocalInstance` and the owner-only shortcut in the tenant plugin. A seeded second user is enough to test it. No UI. P1 does not assume that a missing session may fall back to the owner. Its design waits on §8 question 7 and builds that answer. _Exit:_ the cases in §10 pass.

**P2 — Profiles can be made and removed.** Routes to list, add, rename, set the avatar and remove, refused outside the local edition. A new profile gets its first space through bootstrap's steps. Settings → Profiles for the owner. _Exit:_ a profile added in Settings has its own `Personal` space and does not see the owner's.

**P3 — Who is using Aflow?** The picker at the front door, the footer menu and the per-profile preferred space. The help article lands in this phase. _Exit:_ a fresh install shows no picker, and an install with two profiles shows one.

**P4 — The PIN.** Set, check and reset. _Exit:_ a locked profile cannot start without its PIN, and the owner can reset it.

**P5 — A restricted profile.** Only if the operator answers D4. Its own design comes first.

**Later — The aflow.ai link.** A separate plan, built on §5.

## 10. How it is proven

Each of these cases fails if the change is wrong:

- A second profile with a `member` role calls `GET /v1/spaces` and gets only its own spaces. The owner's `Personal` is absent.
- Profile A stores a user-scoped OpenAI key. A run started by profile B resolves to the tenant key or to none. It never resolves to A's key.
- The owner opens profile B's space by slug and gets the not-found state.
- On an install with one profile and no PIN, a request with the instance secret and no profile session is still the owner. A fresh install and `yarn mcp:setup` work unchanged.
- On an install with a second profile, a browser request with no profile session does not act as the owner. Clearing the cookie or opening a private window reaches no locked profile, the owner's included. What it reaches instead waits on §8 question 7.
- A profile session for a user without an active membership in the pinned tenant is refused with a 403.
- A locked profile's session cannot start without the PIN, through the web or through a direct API call.

## 11. P1 — as built

P1 follows option A. It adds no UI, no route and no table. It adds one column, `users.profile_session_generation`.

### The profile session

- **The value.** A session is `v2.<user id>.<issue time>.<generation>.<MAC>`. The issue time is in Unix seconds. The generation is the user's `profile_session_generation` when the session was issued. The MAC is an HMAC-SHA256 under a key derived from the instance secret (`packages/server-runtime/src/plugins/localProfiles.ts`). It holds no state of its own.
- **Its end.** Removing a profile's membership ends its sessions, because the tenant plugin reads that membership on every request. `bumpLocalProfileSessionGeneration` ends every session issued to one user before the bump, because the API refuses a session whose generation is not the user's. P1 makes no change that bumps it. P4 bumps it when a PIN is set, changed or reset, so a session issued before the PIN cannot start a locked profile (§10). Rotating the instance secret ends every session.
- **Its path.** The browser holds the session in the `aflow_profile_session` cookie. The web process forwards it in `X-Aflow-Profile-Session` beside the instance secret (`apps/web-local/src/compose/localWebIdentity.ts`).
- **Its issue.** `issueLocalProfileSession` issues the value. No route calls it in P1. P3's picker calls it when a profile is chosen, and P4 puts the PIN check in front of it.
- **This differs from §6.** §6 proposed a stored session in `public`. A signed value is enough for P1, because the membership read already revokes it. A stored session returns if §8 question 3 asks for an idle timeout.

### The answer to §8 question 7

`authenticateLocalInstance` (`packages/server-runtime/src/plugins/localInstanceAuth.ts`) holds the rule. It applies to a request that carries the instance secret.

| The request carries                   | One profile                   | Two or more profiles           |
| ------------------------------------- | ----------------------------- | ------------------------------ |
| A profile session                     | That user, membership read    | That user, membership read     |
| A session this instance did not issue | 401 `PROFILE_SESSION_INVALID` | 401 `PROFILE_SESSION_INVALID`  |
| No session, from the web process      | The owner, no membership read | 401 `PROFILE_SESSION_REQUIRED` |
| No session, the bare secret           | The owner, no membership read | The owner, membership read     |

- **What separates a browser from a bare-secret caller.** The web process sets `X-Aflow-Browser-Caller` on every call it makes. The browser cannot remove it, because the web forwards a fixed list of browser headers and sets its own after them. Clearing the cookie or opening a private window therefore reaches no profile once a second one exists.
- **What a bare-secret caller gets.** It stays the owner on every install. `yarn mcp:setup` keeps working. Its holder can read `instance.env` and could issue an owner session, so a refusal would guard nothing (D3).
- **A single profile with a PIN.** P1 gives it a session that names it, read through its membership. P4 must also end the no-session fallback for a single profile that holds a PIN. The one-profile column then applies only to an unlocked profile.
- **The count.** A profile is a human user with an active membership in the pinned tenant. The API reads at most two such rows and keeps the answer for five seconds, so most requests without a session read no database. A one-profile install reaches the owner from that answer while it is fresh. When a read fails, a count last read as two or more still answers several profiles. Any other failed read answers the count as unread: none read since the process started, or a stale count of one. A second profile may exist in either case, so an unread count never grants the owner with no membership read. A browser with no session then gets a 503 `PROFILE_COUNT_UNREAD`. A bare-secret caller stays the owner through the membership read. Only a count read as two or more refuses a browser with `PROFILE_SESSION_REQUIRED`, so that refusal never names a second profile nobody has seen.
- **The generation read.** A request that carries a session reads the user's generation from Postgres before the membership read, so the database is on the path of every sessioned request. A failed read answers 503 `PROFILE_SESSION_UNREAD`.

### The tenant plugin

The owner shortcut at `tenant.ts` applies only to the `sole-profile` principal. A profile session, and the bare secret on an install with several profiles, read `tenant_memberships` as any principal does.

### Tests

- `localInstanceAuth.test.ts` covers the rule on each install for a browser and for a bare-secret caller. It also covers the count cache warm, cold and after a failed read. It shows that neither a count never read nor a stale count of one grants a browser the owner. It covers the session's generation check and a failed generation read.
- `tenantPinning.test.ts` shows that only the sole-profile principal skips the membership read.
- `localProfiles.pg.test.ts` runs the auth and tenant plugins on a bootstrapped install. It then adds a second profile through the `seedLocalProfile` fixture and covers the §10 cases this phase owns. It also shows that a bumped generation ends a session issued before the bump.
