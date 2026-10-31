# Plan 335 — Local profiles: several people share one install

**Status:** 🚧 P1 built under option A (§11). P2 built (§12). P3 built (§13). P4 built (§14). P5 is not built. This document reads the code as it stood, judges three shapes for a profile and proposes phases.

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
- A profile session naming a user with no row is refused with a 401 `PROFILE_SESSION_INVALID`, so the browser goes back to the picker.
- A profile session for a user who has a row and no active membership in the pinned tenant is refused with a 403.
- A locked profile's session cannot start without the PIN, through the web or through a direct API call.

## 11. P1 — as built

P1 follows option A. It adds no UI, no route and no table. It adds one column, `users.profile_session_generation`.

### The profile session

- **The value.** A session is `v2.<user id>.<issue time>.<generation>.<MAC>`. The issue time is in Unix seconds. The generation is the user's `profile_session_generation` when the session was issued. The MAC is an HMAC-SHA256 under a key derived from the instance secret (`packages/server-runtime/src/plugins/localProfiles.ts`). It holds no state of its own.
- **Its end.** Removing a profile's membership ends its sessions, because the tenant plugin reads that membership on every request. `bumpLocalProfileSessionGeneration` ends every session issued to one user before the bump, because the API refuses a session whose generation is not the user's. P1 makes no change that bumps it. P4 bumps it when a PIN is set, changed or reset, so a session issued before the PIN cannot start a locked profile (§10). Rotating the instance secret ends every session.
- **Its path.** The browser holds the session in the `aflow_profile_session` cookie. The web process forwards it in `X-Aflow-Profile-Session` beside the instance secret (`apps/web-local/src/compose/localWebIdentity.ts`).
- **Its issue.** `issueLocalProfileSession` issues the value. No route calls it in P1. P3's picker calls it when a profile is chosen (§13), and P4 puts the PIN check in front of it.
- **This differs from §6.** §6 proposed a stored session in `public`. A signed value is enough for P1, because the membership read already revokes it. A stored session returns if §8 question 3 asks for an idle timeout.

### The answer to §8 question 7

`authenticateLocalInstance` (`packages/server-runtime/src/plugins/localInstanceAuth.ts`) holds the rule. It applies to a request that carries the instance secret. P4 split the one-profile column in two (§14).

| The request carries                   | One profile, no PIN           | One profile with a PIN (P4)    | Two or more profiles           |
| ------------------------------------- | ----------------------------- | ------------------------------ | ------------------------------ |
| A profile session                     | That user, membership read    | That user, membership read     | That user, membership read     |
| A session this instance did not issue | 401 `PROFILE_SESSION_INVALID` | 401 `PROFILE_SESSION_INVALID`  | 401 `PROFILE_SESSION_INVALID`  |
| No session, from the web process      | The owner, no membership read | 401 `PROFILE_SESSION_REQUIRED` | 401 `PROFILE_SESSION_REQUIRED` |
| No session, the bare secret           | The owner, no membership read | The owner, membership read     | The owner, membership read     |

- **What separates a browser from a bare-secret caller.** The web process sets `X-Aflow-Browser-Caller` on every call it makes. The browser cannot remove it, because the web forwards a fixed list of browser headers and sets its own after them. Clearing the cookie or opening a private window therefore reaches no profile once a second one exists.
- **What a bare-secret caller gets.** It stays the owner on every install. `yarn mcp:setup` keeps working. Its holder can read `instance.env` and could issue an owner session, so a refusal would guard nothing (D3).
- **A single profile with a PIN.** P1 gives it a session that names it, read through its membership. P4 ends the no-session fallback for it (§14). A browser with no session gets 401 `PROFILE_SESSION_REQUIRED`, and a bare-secret caller is the owner through the membership read.
- **The count.** A profile is a human user with an active membership in the pinned tenant. The API reads at most two such rows with their PIN hashes and keeps the answer for five seconds. Most requests without a session therefore read no database. The answer is `one`, `one-locked` or `several` (§14). Only a `one` install reaches the owner with no membership read, from that answer while it is fresh. When a read fails, a count last read as `several` or `one-locked` still answers what it last read. Any other failed read answers the count as unread: none read since the process started, or a stale `one`. A second profile or a new PIN may exist in either case, so an unread count never grants the owner with no membership read. A browser with no session then gets a 503 `PROFILE_COUNT_UNREAD`. A bare-secret caller stays the owner through the membership read. Only a count read as `several` or `one-locked` refuses a browser with `PROFILE_SESSION_REQUIRED`. That refusal therefore never names a second profile or a PIN nobody has seen.
- **The generation read.** A request that carries a session reads the user's generation from Postgres before the membership read, so the database is on the path of every sessioned request. A failed read answers 503 `PROFILE_SESSION_UNREAD`. A session naming a user with no row answers 401 `PROFILE_SESSION_INVALID`, so the browser of a removed profile goes back to the picker (§13). P1 left that session to the membership read's 403. A user who has a row and no active membership still gets the 403.

### The tenant plugin

The owner shortcut at `tenant.ts` applies only to the `sole-profile` principal. A profile session, and the bare secret on an install with several profiles, read `tenant_memberships` as any principal does.

### Tests

- `localInstanceAuth.test.ts` covers the rule on each install for a browser and for a bare-secret caller. It also covers the count cache warm, cold and after a failed read. It shows that neither a count never read nor a stale count of one grants a browser the owner. It covers the session's generation check and a failed generation read.
- `tenantPinning.test.ts` shows that only the sole-profile principal skips the membership read.
- `localProfiles.pg.test.ts` runs the auth and tenant plugins on a bootstrapped install. It then adds a second profile through the `seedLocalProfile` fixture and covers the §10 cases this phase owns. It also shows that a bumped generation ends a session issued before the bump.

## 12. P2 — as built

P2 adds the routes and the screen that make and remove profiles. It adds no table and no column.

### The routes

- **Where.** `/v1/local-profiles` lists, adds, renames, sets the avatar, previews a removal and removes (`packages/server-runtime/src/routes/localProfiles.ts`). The service is `packages/server-runtime/src/services/localProfiles.ts`. The shapes are in `packages/schemas/src/edition/localProfiles.ts`.
- **Which edition.** The surface is `core`, as host pairing is. The hosted edition registers it and answers every call with a 404 before authentication.
- **Who.** The owner role alone. The owner's profile session, the bare secret and the sole-profile owner all resolve to it. The route states the rule itself as well as through `owner_admin`, because the authz plugin grants `owner_admin` to an admin when Redis is down.
- **The count.** Adding and removing call `fastify.dropLocalProfileCount`, so the rule in §11 takes effect on the next request.

### Adding a profile

- One transaction writes the user, an active `member` membership and the profile's first space.
- The space comes from `createLocalProfileWorkspace` in `bootstrap/localEdition.ts`. It runs bootstrap's own steps: the `Personal` row with compute off, the admin membership and the default capability profile. Bootstrap now calls the same three steps for the owner.
- The slug is `personal-` and the first twelve hex digits of the user id. Slugs are unique in the one tenant schema, and the owner may hold `personal`.
- **No email.** The user carries none, as §5 says. The P2 brief asked for a `@phoenix.local` identity. §2.3 shows that address belongs to the development bypass user, and §5 rules it out for a profile, so this document was followed.
- **The avatar.** One of eight built-in avatars, stored in `users.avatar_url` as `aflow-avatar:<key>`. `realAvatarUrl` treats the value as no picture, and `UserAvatar` draws the glyph.

### Removing a profile

- The owner cannot be removed.
- Removal runs the account erasure cascade (`accountCascade.ts`), as D2 says. It deletes the spaces only that profile is in. It hands the spaces the profile owns and shares to the owner. It deletes the user, and its memberships go with it. The tenant and every other profile stay.
- Removal first calls `bumpLocalProfileSessionGeneration`, so a session in use is refused from that moment. After the cascade it evicts the user's cached tenant role and publishes the RBAC invalidation. Without the eviction a deleted membership could still answer for up to the cache's lifetime.
- Removal refuses a user with a membership in another tenant, because the cascade would erase it there too. A profile has none, so such a user is not one these routes made.
- Payload objects of the deleted sessions stay where the payload store keeps them. Space purge leaves them the same way.

### Settings → Profiles

- `TenantProfilesPage` lists the profiles with their avatars and offers **Add profile**, **Edit** and **Remove**. P2 shipped **Add profile** disabled (below). Removal shows what the cascade would delete before it asks.
- The tab is gated on the edition and the owner role, never on a surface name. The route ships in the local build only.

### A gap P3 closed — the gate is lifted

P2 issued no profile session, so once a second profile existed every browser got 401 `PROFILE_SESSION_REQUIRED`, the owner's included. The browser that made the profile was refused on its next request, so **Edit** and **Remove** stopped working with it. P2 therefore shipped **Add profile** disabled, with a notice that the add waited for the picker.

P3 lifts that gate. The picker issues sessions (§13), so a second profile no longer locks a browser out. **Add profile** is enabled, and the notice is gone. The browser that adds the second profile is refused on its next request and sent to the picker, where the owner chooses their own profile. Two findings left open on PR #248 are settled by the lift:

- **The gate turned off when the list failed to load** (`tenant-profiles.tsx`). The gate no longer exists, so a failed load enables nothing it would have withheld.
- **The route accepted the lockout add from a sessionless sole-profile principal** (`routes/localProfiles.ts`). That add no longer locks anyone out, so the route keeps accepting it. The add route is unchanged.

### Tests

- `routes/localProfiles.test.ts` covers the refusal outside the local edition and the refusal of a member and an admin session. It shows that an add and a removal drop the count and a refused removal does not.
- `services/localProfiles.test.ts` shows that removal bumps the generation before the cascade and evicts the cached role after it.
- `routes/localProfiles.pg.test.ts` runs the real plugins on a bootstrapped install with the count cached for its usual lifetime. A profile added there has its own `Personal` space and lists none of the owner's. The owner sees that space as a name only. Rename and avatar persist. A member session and an admin from the seed fixture are refused on every route. Removal ends the profile's session, drops the count and leaves the tenant and the owner.
- `tenant-settings/tabs.test.ts` shows the tab only for the local owner.

## 13. P3 — as built

P3 adds the picker, the footer menu and the per-profile preferred space. It adds no table and no column.

### The picker routes

- **Where.** Two routes join `/v1/local-profiles` in a scope of their own, so the owner rule of §12 never reaches them (`packages/server-runtime/src/routes/localProfiles.ts`). `GET /picker` lists each profile's id, name, avatar and whether it is the owner. `POST /:userId/session` issues that profile's session.
- **Who.** A request that presents the instance secret as its bearer token, with or without a profile session. An API key is refused, because a key already names its user. The hosted edition answers both routes with the 404 of §12.
- **The only issuer.** `POST /:userId/session` is the one caller of `issueLocalProfileSession`. It issues a session only for a profile of the pinned tenant, at the user's current generation, and answers 404 for anything else. It refuses a request with `X-Aflow-Browser-Caller` with a 403. The web process marks every call it proxies for the browser, so a session never passes back through the proxy to a script in the page.
- **§10 holds.** A browser with no session on an install with two profiles is still refused by `authenticate`. It reaches only the picker's two routes, and those never act as the owner. The picker marks which profile is the owner, and the mark grants nothing. It acts as a profile only once it holds that profile's session.

### The web process

- **The front door.** `apps/web-local/src/app/page.tsx` asks the API for the browser's spaces, as before. A 401 `PROFILE_SESSION_REQUIRED` or `PROFILE_SESSION_INVALID` renders **Who is using Aflow?** in place of a space (`answerRefusal` on `enterPreferredSpace`). An install with one profile never refuses a browser that sends no session, so a fresh install shows no picker. A browser that sends a session the API refuses still sees the picker, whatever the profile count. One that holds a removed profile's session sees it on an install now down to one profile.
- **A choice.** Each tile is a submit button in a plain form that posts to `/profiles/choose` (`apps/web-local/src/compose/localProfileSession.ts`). That route asks the API for the session with the bare secret. It keeps the session in the `httpOnly` cookie `aflow_profile_session` and the chosen user id in `aflow_profile`, then redirects to the front door. The admission check refuses a post from another origin. A refused choice returns to the picker with a notice and sets no cookie.
- **The cookie's life.** The session lasts until the person switches profile or the browser clears it. The cookie keeps it for 400 days, the longest a browser allows. It is `Secure` where the browser used HTTPS.
- **Recovery.** A 401 `PROFILE_SESSION_REQUIRED` or `PROFILE_SESSION_INVALID` from any screen now sends the browser to the front door, and so to the picker (`localRecovery.ts`). P1 showed a message there.
- **A removed profile.** A session naming a user with no row answers 401 `PROFILE_SESSION_INVALID` (§11). The browser that used a removed profile therefore reaches the picker rather than a 403.

### The footer menu

- In the local edition the avatar at the foot of the sidebar opens a menu instead of `/account` (`packages/web-product/src/ui/components/profile-menu.tsx`). It names the profile using Aflow now. With two or more profiles it lists the others, each a post to `/profiles/choose`, and **Switch profile**, which opens the picker at `/profiles`. The owner also sees **Manage profiles**, which opens Settings → Profiles. **Account settings** opens `/account`.
- `/profiles` sends an install with one profile to the front door. Switch profile on such an install therefore shows no picker. The front door still shows one for a refused session.
- The hosted footer is unchanged.

### The preferred space

- The preferred-space cookie is keyed by the chosen profile: `preferredSpaceSlug.<user id>`, from the `aflow_profile` cookie (`packages/web-product/src/preferredSpaceCookie.ts`). A browser that chose no profile keeps `preferredSpaceSlug`, so a one-profile install and the hosted edition are unchanged.
- A chosen profile with no keyed hint reads `preferredSpaceSlug`. The owner who adds a second profile and picks themselves lands in the space they were using. The write always goes to the keyed cookie, and clearing removes both.
- The front door now skips a space listed as a name only (`myRole: null`). Otherwise the owner could land on another profile's space and get the not-found state.

### Not built

- An **Add profile** tile on the picker (D1). Adding stays in Settings → Profiles, because the picker answers a browser that holds no session and cannot tell the owner apart.
- The PIN. P4 builds it (§14).

### Tests

- `routes/localProfiles.test.ts` shows the picker answers a browser that `authenticate` refuses for want of a session, and refuses anything but the instance secret. It shows a session is issued at the user's generation only for a profile that exists, and never to a proxied browser call.
- `routes/localProfiles.pg.test.ts` adds a second profile on a bootstrapped install. The sessionless browser is refused, and the picker lists both profiles. The session the picker issues lets the owner keep managing profiles.
- `plugins/localInstanceAuth.test.ts` and `plugins/localProfiles.pg.test.ts` show a session naming no user is a 401 `PROFILE_SESSION_INVALID`.
- `apps/web-local/src/compose/localProfileSession.test.ts` shows the front door shows the picker only for a profile refusal. It shows a choice sets the `httpOnly` session cookie only when the API issued a session, and asks without the browser mark.
- `apps/web-local/src/app/frontDoor.test.ts` shows the picker's routes exist in the local build.
- `localRecovery.test.ts` shows a profile refusal sends the browser to the picker.
- `preferredSpace.test.ts` shows each profile keeps its own preferred space, and a profile with none reads the unkeyed one. `enterPreferredSpace.test.ts` shows a name-only space is skipped and a refusal can be answered with the picker.
- `profile-menu-entries.test.ts` shows the menu offers a switch only with two profiles and **Manage profiles** only to the owner.
- `tenant-profiles.test.ts` shows **Add profile** is no longer gated on the profile count.

## 14. P4 — as built

P4 adds the PIN. It adds one column, `users.profile_pin_hash`, and no table.

### The PIN and its storage

- **The value.** Four to six digits (D3), checked by `LocalProfilePinSchema` in `packages/schemas/src/edition/localProfiles.ts`.
- **The storage.** `users.profile_pin_hash` holds a salted scrypt hash in the form `scrypt$N$r$p$<salt>$<key>` (`packages/server-runtime/src/services/localProfilePin.ts`). Null means the profile has no PIN. The digits are never stored, because people reuse a PIN elsewhere.
- **What the hash does not do.** Four to six digits are few, so someone who reads the database can try them all. That person holds the operator's OS account, and D3 claims no boundary against them.
- **A damaged hash.** A stored value the module did not write matches no PIN. The profile stays locked until the owner resets it.

### The routes

- **Set and change.** `PUT /v1/local-profiles/:userId/pin` takes `{ pin }` and answers the profile. It sits in the management scope of §12, so it is owner only and answers the hosted edition with a 404.
- **Reset.** `DELETE /v1/local-profiles/:userId/pin` clears the hash. It is the owner's answer to a forgotten PIN (D3). It sits in the same scope.
- **Check.** `POST /:userId/session` checks the PIN. A locked profile needs `{ pin }` in the body. A missing PIN answers 401 `PROFILE_PIN_REQUIRED`, and a wrong one 401 `PROFILE_PIN_INCORRECT`. Neither issues a session. A profile with no PIN starts as P3 does and ignores a PIN it is sent.
- **No separate check route.** An owner-only route that answers whether a PIN matches was not built. The owner can already reset any PIN, so the route would add only a way to learn the PIN a person chose.
- **Who sets a PIN.** The owner alone, as the commission states for these routes. D5 offered each profile its own PIN on `/account/profile`. That page is not built, because a member who sets a PIN gains nothing the owner's reset cannot undo, and it would need a route outside the owner scope.

### Ending sessions

- Setting, changing and resetting each call `bumpLocalProfileSessionGeneration` in the transaction that writes the hash (`setLocalProfilePin` and `resetLocalProfilePin` in `services/localProfiles.ts`). Every session issued to that profile before the change is refused from the commit on.
- The session route reads the generation and the hash in one row (`readLocalProfileSessionGate`). Two reads could pair the old PIN with the new generation, and issue a session the new PIN never let through.
- The owner who locks their own profile ends their own session too. Their browser returns to the picker and asks for the new PIN.
- Each change also calls `fastify.dropLocalProfileCount`, so the rule below takes effect on the next request.

### The lifted fallback

- `readLocalProfileCount` replaces `hasSeveralLocalProfiles` (`plugins/localProfiles.ts`). It answers `one`, `one-locked` or `several` from the same two-row read.
- `authenticateLocalInstance` grants the sole-profile owner only for `one`. A browser with no session on a `one-locked` install gets 401 `PROFILE_SESSION_REQUIRED` and goes to the picker. A bare-secret caller stays the owner through the membership read, as on an install with several profiles.
- The §11 table splits its one-profile column in two. On one profile with a PIN, "No session, from the web process" answers 401 `PROFILE_SESSION_REQUIRED`. "No session, the bare secret" answers the owner through the membership read.
- **A failed read.** A count last read as `one-locked` keeps answering `one-locked` when a later read fails, as `several` does. A stale `one` still answers `unread`, so a PIN set since that read is never skipped.

### Wrong guesses

- `LocalProfilePinAttempts` counts wrong PINs in the API process, per profile and per PIN mark. The first four on a count cost nothing. Each one after them makes that count wait, 30 seconds at first and doubling to 15 minutes. A waiting count answers 429 `PROFILE_PIN_THROTTLED` with `Retry-After`, whatever PIN it is sent.
- A guess is counted before it is compared, so guesses sent at once cannot all pass the wait while the first one is still being compared. A right PIN sent with a live mark clears that mark's count. A right PIN sent with no live mark takes back only the guess it added. The unmarked count holds the guesses of every browser with no mark, so one browser's right PIN never resets the wait another browser earned. A new PIN and a reset clear every count of the profile.
- **One count per profile id.** A uuid reads the same in any letter case, and the counts and marks are keyed by its text. The route parameter is lowered to the form Postgres answers before anything reads it, so every case variant of one id keys one count.
- **Pruning.** A count goes once it has outlived its wait by 75 minutes with no further wrong guess. Each wrong guess sweeps every count past that point, so the counts do not only grow.
- **Why 75 minutes and not the moment the wait ends.** Dropping a count frees the four free guesses and the one that started the wait. Dropping it as its wait ends would give a guesser five guesses every 30 seconds. Seventy-five minutes is five longest waits, so waiting for a count to go costs as much per guess as the longest wait does.
- A restart clears the counts too. Restarting the API needs the operator's machine, where the PIN guards nothing (D3).

### The PIN mark — one browser cannot lock another out

Round 1 kept one count per profile. Anyone at any browser could then keep a profile waiting 15 minutes by sending one wrong PIN each time the wait ended. The owner's own profile had no recourse in the UI, because only the owner resets a PIN. Round 2 keys the count so a browser that never knew the PIN cannot make the owner's browser wait.

- **The mark.** A right PIN answers `pinMark` beside the session: `m2.<user id>.<generation>.<nonce>.<MAC>`, signed under a key derived from the instance secret (`issueLocalProfilePinMark` in `services/localProfilePin.ts`). `generation` is the profile's session generation when the mark was issued. The web process keeps it in the `httpOnly` cookie `aflow_pin_mark_<user id>` and sends it with the next PIN for that profile. A browser that sends a live mark keeps it. Any other right PIN gets a new one.
- **Live marks.** A mark is live when the instance signed it for this profile at the profile's current generation, and the API process still holds its nonce. `LocalProfilePinAttempts` holds at most eight nonces per profile, least recently used first. A right PIN sent with a live mark makes it the most recent. Issuing a ninth drops the least recently used mark, and that mark's count goes with it.
- **The counts.** Wrong PINs sent with a live mark go to that mark's own count. Wrong PINs sent with no mark, or with a mark that is not live, share one count per profile.
- **Why a mark and not a browser id.** An id the web process mints for any browser is free to replace. Clearing cookies would then reset the count, and the throttle would stop nothing. A mark comes only from a right PIN, so a guesser without the PIN holds none and cannot make one up. The mark grants nothing, and names only the count its browser's wrong guesses go to.
- **Why not a recourse instead.** A UI recourse open to the locked-out owner is open to anyone at that browser, because nothing tells them apart before the PIN. The recourse that tells them apart is the instance secret, and it exists already (below).
- **What it does not solve.** Nothing tells the owner from another person at the browser that holds the owner's mark, so they share its count. That person can keep that browser waiting. The owner can still open the profile from a browser with no mark, unless the same person keeps the unmarked count waiting too. The PIN claims no boundary against a person at the operator's own machine (D3), and the instance secret below stays the owner's last recourse.
- **Its lifetime.** The cookie lasts as the profile session does. The mark stops being live sooner on any of these events.
  - A new PIN, a changed PIN or a reset bumps the generation in the transaction that writes the hash (§14 Ending sessions). Every mark signed at an earlier generation then reads as none.
  - The same change, and a profile's removal, clear the profile's live nonces and its counts in the API process.
  - Eight newer marks for the profile drop it.
  - A restart of the API clears every live nonce. A browser then counts with the unmarked browsers until its next right PIN issues it a new mark.

### Marks end with the PIN

Round 2 left a mark valid across a PIN change or reset, and anyone who knew the PIN could mint as many marks as they wanted. Each mark keyed a fresh count with four free guesses. Someone who learned the old PIN could therefore collect marks first, then try the new PIN at a rate the throttle did not limit. Changing a PIN to lock out a person who learned it is the main reason to change it, so round 3 binds a mark to the PIN.

- **The invalidation rule.** A mark is read at the profile's current session generation and at no other. Setting, changing and resetting a PIN each bump the generation in the transaction that writes the hash, so every outstanding mark reads as none from the commit on. Its wrong PINs then go to the shared unmarked count. Removing a profile bumps the generation as well.
- **Why the generation.** It is the counter a PIN change already bumps to end the profile's sessions, and the session route reads it in the same row as the hash. A mark and a session issued before a change therefore end together. Other changes that bump the generation also end the marks, which costs a browser its own count until its next right PIN.
- **The bound.** Eight live marks per profile limit what knowing the current PIN buys to eight counts of free guesses. That person already knows the PIN, so the bound matters for the next change, and the change clears them all.
- **What it does not change.** A mark still grants nothing, and a browser that never knew the PIN still holds none.

### The web process

- **The picker.** A locked profile's tile shows **PIN** and links to `/profiles?unlock=<user id>` instead of posting. That page shows the PIN prompt, a plain form that posts the choice and the PIN to `/profiles/choose` (`packages/web-product/src/ui/components/profile-picker.tsx`). An install whose only profile is locked shows the prompt at the front door at once.
- **A choice.** `/profiles/choose` sends the PIN to the API in a JSON body, with the bare secret and no browser mark. A PIN refusal returns to the prompt with the reason in `pin=required|incorrect|throttled` and sets no cookie (`apps/web-local/src/compose/localProfileSession.ts`). A throttled PIN also carries `until`, the Unix second the API's `Retry-After` names. The page counts the remaining wait from it on each load, and the prompt names it: "Try again in 30 seconds" or "in 15 minutes". Once the wait has passed, the prompt asks plainly again. A choice sends the profile's PIN mark cookie with its PIN, and a right PIN sets the mark the API answered.
- **`/profiles`.** `showsLocalProfilePicker` now answers true for two profiles or for a locked one. A single locked profile therefore reaches its prompt at `/profiles`. The footer menu keeps its own rule, `offersLocalProfileSwitch`, which still needs a second profile.
- **The footer menu.** A locked profile in the switch list opens its prompt instead of posting.
- **Settings → Profiles.** Each row shows **PIN** when the profile has one and offers **Set PIN** or **Change PIN**, and **Reset PIN** where one is set. The page says in one sentence that a PIN does not guard against someone who can sign in to the computer's account (D3).

### A known gap

Nobody above the owner can reset the owner's own forgotten PIN in the UI. A request with the instance secret still acts as the owner, so `DELETE /v1/local-profiles/<owner id>/pin` with that secret resets it. The help article says so. A command that wraps the call is not built.

### Tests

- `services/localProfilePin.test.ts` shows the hash is salted and holds no digit in the clear, matches no other PIN, and refuses a damaged hash. It covers the wait and its doubling. It shows a marked count stays apart from the unmarked one, and a reset clears both counts and the live marks. A profile keeps eight live marks and drops the least recently used. A count stays until it has outlived its wait by 75 minutes, and goes after. A mark reads as nothing for another profile, another secret, a forged nonce or another generation.
- `services/localProfiles.test.ts` shows a set and a reset write the hash and bump the generation in one transaction.
- `routes/localProfiles.test.ts` shows only the owner sets and resets, each change drops the count, and a malformed PIN is refused. A locked profile gets no session without its PIN or with a wrong one. The right PIN issues one at the current generation. Five wrong PINs make the profile wait until the owner resets it. A right PIN answers a mark, and wrong PINs from browsers without it never make the marked browser wait. Marks collected before a PIN change or a reset all count with the unmarked browsers afterwards. A mark that eight newer marks have dropped counts with them too. Every letter case of one profile id shares one count. A right PIN from a browser with no mark leaves the count and the doubled wait another browser earned.
- `plugins/localInstanceAuth.test.ts` shows a sessionless browser on a `one-locked` install is refused, a bare-secret caller stays the owner, and the cache keeps `one-locked` through a failed read.
- `routes/localProfiles.pg.test.ts` covers the §10 locked-profile cases on a bootstrapped install. A single profile with a PIN no longer falls back to the owner, and its earlier session ends. It cannot start without its PIN, and a wrong PIN issues nothing. The owner's reset ends the PIN's session and restores the fallback. A second profile is locked and reset the same way. A mark it answered before a PIN change keys no count of its own after the change. Wrong PINs sent under any letter case of a profile's id share one count. A right PIN from a browser with no mark leaves a guesser's count where it was.
- `apps/web-local/src/compose/localProfileSession.test.ts` shows the PIN reaches the API in the body, and a refused PIN returns to the prompt with no cookie. A throttled PIN carries the API's wait to the prompt, and the page counts down from it. The mark a right PIN returns is kept and sent back with the next PIN.
- `profile-pin-message.test.ts` shows the throttled prompt names the wait in seconds and then in minutes.
- `profile-menu-entries.test.ts` shows a single locked profile offers no switch.
