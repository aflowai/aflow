/**
 * Who owns every file in this repository.
 *
 * The editions already behave differently — the descriptor resolves one, the
 * surface registry composes routes for it, the web app gates pages on it. None
 * of that changes what is *in* a build: one image carries every executor, and
 * the local artifact still contains cloud-only code. Deciding what a public
 * core cut may delete needs a classification of everything, not of the parts
 * somebody remembered.
 *
 * This is that classification, and it is the classification rather than a
 * description of one: `ownershipGuard.test.ts` fails on a tracked file no rule
 * matches, so a new workspace, page, script or deployment file cannot arrive
 * without its edition being decided. The guards that came before it — the
 * surface registry's `tier`, `ENTERPRISE_ONLY_ENV_KEYS` — stay the authority
 * for what they already cover, and are read rather than restated here.
 *
 * Longest match wins, as it does in the sandbox policy, so a directory states
 * the rule and a file inside it states the exception.
 */

/**
 * What a public core cut does with a path.
 *
 * - `core` — both editions. The engine, the contracts, the product.
 * - `local` — the local edition only. Absent from the hosted build.
 * - `cloud` — the private repository. Absent from the local build.
 * - `optional-pack` — core, but shipped as an opt-in package rather than in
 *   the base artifact; the operator bears its cost or risk.
 * - `development` — in neither product artifact. Tooling, plans, fixtures.
 * - `delete` — dead on arrival at the cut: a one-off already run, a scratch
 *   file that outlived its branch. Classified rather than quietly carried.
 */
export type OwnershipClass =
  'core' | 'local' | 'cloud' | 'optional-pack' | 'development' | 'delete';

export interface OwnershipRule {
  /**
   * Repo-relative path. A trailing `/` matches the directory and everything
   * under it; anything else matches that exact file.
   */
  path: string;
  owner: OwnershipClass;
  /** Only where the classification is not obvious from the path. */
  why?: string;
}

export const OWNERSHIP_MANIFEST: readonly OwnershipRule[] = [
  // ── Engine and contracts ────────────────────────────────────────────────
  // Engine layers and contracts. Listed one by one on purpose: a blanket
  // `packages/` rule would answer for a package that does not exist yet, and
  // the whole point of the guard is that a new one arrives undecided.
  {
    path: 'packages/authz/',
    owner: 'core',
    why: 'Roles, the permission check and its cache run in both editions. It was mixed while a relationship plane was half-built here; that was never wired to anything and has been removed, so the package is whole.',
  },
  { path: 'packages/ai-client/', owner: 'core' },
  { path: 'packages/applet-runtime/', owner: 'core' },
  { path: 'packages/credential-resolver/', owner: 'core' },
  { path: 'packages/cybernetic-hooks/', owner: 'core' },
  { path: 'packages/cybernetic-runtime/', owner: 'core' },
  { path: 'packages/database/', owner: 'core' },
  { path: 'packages/design-system/', owner: 'core' },
  { path: 'packages/executor-runtime/', owner: 'core' },
  { path: 'packages/input-resolution/', owner: 'core' },
  { path: 'packages/integration-simulator/', owner: 'core' },
  { path: 'packages/lib/', owner: 'core' },
  { path: 'packages/memory-paths/', owner: 'core' },
  { path: 'packages/memory-store/', owner: 'core' },
  { path: 'packages/network-safety/', owner: 'core' },
  { path: 'packages/oauth/', owner: 'core' },
  { path: 'packages/observability/', owner: 'core' },
  // The crash reporter, and the only workspace that declares its SDK. The local
  // edition ships no reporter at all rather than a dormant one (246d §6b): an
  // unset `SENTRY_DSN` is a configuration a later default can turn back on, and
  // one the person who installed the appliance cannot audit, where absence is a
  // property they can check. Core reaches it, where a build has one, through
  // `@aflow/observability/crashReporting`, which requires this by name at
  // runtime — so removing the workspace removes the reporter and its SDK
  // together, and leaves no surviving manifest declaring either.
  { path: 'packages/crash-reporter-sentry/', owner: 'cloud' },
  { path: 'packages/payload-store/', owner: 'core' },
  { path: 'packages/web-product/', owner: 'core' },
  {
    path: 'packages/server-runtime/',
    owner: 'core',
    why: 'What the API server is, for the applications that compose it: the factory, the core surfaces, the plugins and the routes. An application is a process entry point over this.',
  },
  { path: 'packages/platform-artifacts/', owner: 'core' },
  { path: 'packages/redis/', owner: 'core' },
  { path: 'packages/run-view/', owner: 'core' },
  { path: 'packages/schemas/', owner: 'core' },
  { path: 'packages/surface-engine/', owner: 'core' },
  { path: 'packages/ui-artifact-compiler/', owner: 'core' },
  { path: 'apps/server/', owner: 'core' },
  { path: 'apps/web/', owner: 'cloud' },
  { path: 'apps/aflow-orchestrator/', owner: 'core' },
  { path: 'apps/aflow-executor-ai/', owner: 'core' },
  { path: 'apps/aflow-executor-api/', owner: 'core' },
  { path: 'apps/aflow-executor-user/', owner: 'core' },
  { path: 'apps/aflow-executor-memory/', owner: 'core' },
  { path: 'apps/aflow-executor-ui/', owner: 'core' },
  { path: 'apps/aflow-executor-mcp/', owner: 'core' },
  { path: 'apps/aflow-mcp/', owner: 'core' },

  {
    path: 'apps/aflow-executor-compute/',
    owner: 'core',
    why: 'Running code is one of the capabilities this product exists to offer, so it ships in the base artifact and starts with everything else. It reaches the Docker socket, which is host root whoever holds it — production gives it a host of its own for that reason, and a local operator takes that reach on their own machine as the price of the capability.',
  },
  {
    path: 'apps/web-local/',
    owner: 'local',
    why: "The local edition's web application: thin Next entry points over @aflow/web-product, composing the instance identity. An application here is route files, a proxy and a configuration wrapper — what the product is lives in the shared package, so the two applications cannot drift into two products.",
  },
  {
    path: 'apps/aflow-executor-host/',
    owner: 'local',
    why: 'Pairs with a machine the operator runs. A hosted deployment has no computer to reach, which is why the surface is edition-gated rather than merely unconfigured.',
  },
  {
    path: 'apps/aflow-executor-code/',
    owner: 'cloud',
    why: 'The managed coding lane. Needs egress, a full toolchain and credentials Aflow operates; §2.2 keeps it private.',
  },
  {
    path: 'apps/aflow-voice/',
    owner: 'cloud',
    why: 'Managed voice lane — LiveKit plus xAI speech and transcription, none of which the local product carries.',
  },
  {
    path: 'apps/aflow-executor-mock/',
    owner: 'development',
    why: 'Contract testing only. `dev:core` runs it, and no profile that serves a person does.',
  },

  // The private distribution is a workspace, so the boundary is a directory
  // rather than a list. Each file here once carried its own rule explaining why
  // it was cloud and not core; where it lives answers that now.
  // `editionClosure.test.ts` no longer computes that closure — it asserts the
  // seam instead, since the directory answers what the walk used to measure: no
  // core module imports this workspace, and this workspace reaches the core only
  // through subpaths the core publishes. A cross-seam import lands as a failing
  // guard rather than as a broken build after the split.
  {
    path: 'apps/server-hosted/',
    owner: 'cloud',
    why: 'The hosted distribution: the identity plane it supplies, the surfaces only it serves, and the entry point that composes them over the core runtime.',
  },

  // The identity plane the hosted distribution supplies (§4.2). Core composes
  // none and verifies bearer tokens with a development symmetric secret, which
  // `assertProductionSecurityConfig` refuses to let a production boot rely on.

  {
    path: 'packages/auth0-management/',
    owner: 'cloud',
    why: "The hosted identity provider's management API. Its own workspace rather than a subpath of `packages/oauth`, so no cloud file sits inside a public package and the private half can consume the core as a whole rather than patching into it.",
  },

  // A test of an enterprise module moves with it (§4.5). Left behind, each of
  // these is an import of a file that no longer exists — which is how the
  // first real run of this cut failed.

  // ── Build, test and release pipeline ────────────────────────────────────
  { path: 'package.json', owner: 'core' },
  { path: 'yarn.lock', owner: 'core' },
  { path: 'tsconfig.json', owner: 'core' },
  { path: 'tsconfig.base.json', owner: 'core' },
  { path: 'vitest.config.ts', owner: 'core' },
  { path: 'eslint.config.mjs', owner: 'core' },
  { path: 'eslint-rules/', owner: 'core' },
  { path: '.yarnrc.yml', owner: 'core' },
  { path: '.node-version', owner: 'core' },
  { path: '.nvmrc', owner: 'core' },
  { path: '.editorconfig', owner: 'core' },
  { path: '.prettierrc.json', owner: 'core' },
  { path: '.prettierignore', owner: 'core' },
  { path: '.gitignore', owner: 'core' },
  { path: '.dockerignore', owner: 'core' },
  { path: '.lint-baseline', owner: 'development' },
  { path: '.vscode/', owner: 'development' },
  { path: 'proto/', owner: 'core' },

  // ── Images and deployment ───────────────────────────────────────────────
  {
    path: 'Dockerfile',
    owner: 'core',
    why: 'One image builds every workspace today. P1 replaces it with per-composition images; until then it is shared, not cloud-only.',
  },
  { path: 'docker/', owner: 'core' },
  { path: 'docker-compose.local.yml', owner: 'local', why: 'The appliance topology.' },
  { path: 'docker-compose.yml', owner: 'development', why: 'Postgres and Redis for a dev stack.' },
  { path: 'cloudbuild.yaml', owner: 'cloud' },
  { path: 'app.json', owner: 'cloud', why: 'Heroku app manifest.' },
  { path: 'Procfile', owner: 'cloud', why: 'Heroku process types.' },
  { path: 'heroku.yml', owner: 'cloud' },
  { path: '.gcloudignore', owner: 'cloud' },

  // ── CI ──────────────────────────────────────────────────────────────────
  { path: '.github/', owner: 'core', why: 'The public test and release pipeline.' },
  {
    path: '.github/workflows/deploy-gcp.yml',
    owner: 'cloud',
    why: 'Deploys the hosted deployment. Fleet operations are private (§2.2).',
  },
  {
    path: '.github/workflows/request-review.yml',
    owner: 'cloud',
    why: 'Requests review through a GitHub App whose key only the private repository holds; a fork pull request gets no secrets and would fail it.',
  },
  {
    path: '.github/workflows/edition-seam.yml',
    owner: 'cloud',
    why: 'Both proofs need the private half: the cut starts from the whole tree, and the consumer builds the cloud files over the core. The public repository is already a cut, and its own suite runs the ownership guards over it.',
  },
  { path: 'scripts/cloud-consumer-proof.mjs', owner: 'cloud' },
  { path: 'scripts/seam-paths.mjs', owner: 'cloud' },
  { path: 'packages/lib/src/__tests__/seamPathsCoverage.test.ts', owner: 'cloud' },
  {
    path: 'scripts/create-pr.sh',
    owner: 'cloud',
    why: "Opens pull requests as the maintainers' GitHub App so its approvals satisfy the private ruleset.",
  },

  // Web pages whose whole subject is a plane the local edition has no server
  // for. Their tabs are already filtered by the surface the edition composed,
  // so locally they are unreachable; a cut deletes them rather than shipping a
  // page that renders and cannot work.

  // ── Licensing and governance ────────────────────────────────────────────
  // The public repository is the one these govern, and the cut is what produces
  // it, so they are carried rather than withheld.
  { path: 'LICENSE', owner: 'core' },
  { path: 'NOTICE', owner: 'core' },
  { path: 'SECURITY.md', owner: 'core' },
  { path: 'CODE_OF_CONDUCT.md', owner: 'core' },
  { path: 'TRADEMARK.md', owner: 'core' },
  { path: 'THIRD-PARTY-NOTICES.md', owner: 'core' },
  { path: 'scripts/third-party-notices.mjs', owner: 'core' },

  // ── Documentation and agent instructions ────────────────────────────────
  { path: 'README.md', owner: 'core' },
  { path: 'CONTRIBUTING.md', owner: 'core' },
  { path: 'CLAUDE.md', owner: 'development' },
  {
    path: 'CLAUDE.hosted.md',
    owner: 'cloud',
    why: 'Agent context for the hosted distribution: its topology, deploy commands, maintainer skills and the private plan archive. CLAUDE.md imports it where it exists.',
  },
  { path: 'AGENTS.md', owner: 'development' },
  {
    path: 'docs/',
    owner: 'development',
    why: 'Architecture and contributor documentation. The publication audit ran over this tree and the exceptions below are its result: what stays here is engineering reference a contributor reads, and everything that is working material, positioning, or a record of internal review is named as cloud.',
  },
  {
    path: 'docs/plans/',
    owner: 'core',
    why: 'CONTRIBUTING asks for a numbered plan before a large change, and a plan written for the core belongs with the core.',
  },
  {
    path: 'docs/plans/aflow/',
    owner: 'cloud',
    why: 'The archive of plans written before publication. It carries cost figures, competitor and go-to-market notes, production identifiers, and candid assessments of what does not work yet — none of it secret, all of it read differently by somebody deciding whether to adopt the product. Individual plans can be promoted to core when one earns it, which is a decision rather than a default.',
  },
  { path: 'docs/plans/aflow-platform-draft-specs.md', owner: 'cloud' },
  { path: 'docs/plans/duality-games/', owner: 'cloud' },
  { path: 'docs/plans/fixes/', owner: 'cloud' },
  {
    path: 'docs/infra/',
    owner: 'cloud',
    why: "Hosted operations: the production topology after Plans 36, 68 and 79, and the runbook for publishing Aflow's own Google OAuth apps under its verified brand. A local instance deploys nothing and has no brand to verify.",
  },
  {
    path: 'docs/dev/observability-sentry.md',
    owner: 'cloud',
    why: 'The local edition ships no crash reporter at all (246d §6b), so this documents a component the public core does not contain — and it names the Sentry organisation and its ingest endpoint.',
  },
  {
    path: 'docs/specs/memory-put-semantics-and-input-resolution-bug.md',
    owner: 'cloud',
    why: 'A diagnosis written against one incident, not a specification of how the system behaves.',
  },
  {
    path: 'docs/dev/coding-lane-local.md',
    owner: 'cloud',
    why: 'The managed coding lane runs on infrastructure Aflow operates and its executor is not in this edition, which reaches a harness through the host lane instead.',
  },
  {
    path: 'docs/dev/kaggle-p6-handoff.md',
    owner: 'cloud',
    why: 'A working note between sessions, whose authoritative specs are plans that are not published.',
  },
  {
    path: 'docs/research/',
    owner: 'cloud',
    why: 'Design reviews, UX audits of the hosted workbench, and roadmap critique. A record of internal review rather than a description of the system.',
  },
  {
    path: 'docs/aflow-space-vision.md',
    owner: 'cloud',
    why: 'An end-state vision, which a public repository would read as a product promise rather than as documentation of what the code does.',
  },
  {
    path: 'docs/aflow-platform-engine-summary.md',
    owner: 'cloud',
    why: 'Positioning for teams who would build on the engine — an end state addressed to a commercial reader, not engineering reference.',
  },
  { path: '.claude/', owner: 'development' },
  {
    path: '.claude/projects/',
    owner: 'cloud',
    why: "A coding agent's own memory notes, committed here by accident. They carry hosted operational detail — the worker VM's boot sequence, image sizes, Secret Manager reads — and the directory name carries a local home-directory layout.",
  },
  { path: '.agents/', owner: 'development' },
  // Auth0 is the hosted identity provider and the local edition has none, so
  // these teach a stack the public core cannot use.
  { path: '.agents/skills/auth0-nextjs/', owner: 'cloud' },
  { path: '.agents/skills/auth0-quickstart/', owner: 'cloud' },
  // Symlinks into `.agents/`, so they are files rather than directories here.
  { path: '.claude/skills/auth0-nextjs', owner: 'cloud' },
  { path: '.claude/skills/auth0-quickstart', owner: 'cloud' },
  // The maintainers' plan and release process: numbered plans under the private
  // archive, a master index, and pull requests opened as the GitHub App.
  { path: '.claude/skills/commit/', owner: 'cloud' },
  { path: '.claude/skills/complete-plan/', owner: 'cloud' },
  { path: '.claude/skills/document/', owner: 'cloud' },
  { path: '.claude/skills/phase/', owner: 'cloud' },
  { path: '.claude/skills/plan/', owner: 'cloud' },
  { path: '.agents/skills/commit/', owner: 'cloud' },
  { path: '.agents/skills/document/', owner: 'cloud' },
  { path: '.agents/skills/plan/', owner: 'cloud' },
  { path: '.cursor/', owner: 'development' },

  // ── Assets and generated data ───────────────────────────────────────────
  { path: 'strawberry-robot.svg', owner: 'core' },
  {
    path: 'skills-lock.json',
    owner: 'cloud',
    why: 'Locks the two Auth0 skills, which are cloud.',
  },
  { path: '.env.example', owner: 'core' },

  // ── Scripts ─────────────────────────────────────────────────────────────
  { path: 'scripts/', owner: 'development' },
  {
    path: 'scripts/prod-launcher.mjs',
    owner: 'core',
    why: 'Resolves PHOENIX_PROFILE in both the appliance and production.',
  },
  { path: 'scripts/postinstall.mjs', owner: 'core' },
  {
    path: 'scripts/core-cut.mjs',
    owner: 'core',
    why: 'The release proof a public repository has to be able to run against itself (§5a).',
  },
  { path: 'scripts/init-db.sql', owner: 'core' },
  { path: 'scripts/migrate-tenants.ts', owner: 'core' },
  {
    path: 'scripts/rewrap-credentials.mjs',
    owner: 'core',
    why: 'Credential rewrapping is an operator task in either edition.',
  },
  {
    path: 'scripts/delete-user-account.ts',
    owner: 'cloud',
    why: 'GDPR erasure for a hosted account, and it erases the Auth0 identity as one of its effects. A local instance has one owner and no identity provider to erase them from, which is a different procedure.',
  },
  {
    path: 'scripts/export-run-debug-bundle.ts',
    owner: 'core',
    why: 'Local diagnostics are core (§2.3).',
  },
  { path: 'scripts/tail-run-events.ts', owner: 'core' },
  { path: 'scripts/regenerate-store-catalog-hashes.ts', owner: 'core', why: 'The Store is core.' },
  { path: 'scripts/store-connector-smoke.ts', owner: 'core' },

  { path: 'scripts/appliance-backup.sh', owner: 'local' },
  { path: 'scripts/appliance-restore.sh', owner: 'local' },
  { path: 'scripts/appliance-init-db.sql', owner: 'local' },
  { path: 'scripts/appliance-smoke.sh', owner: 'local' },
  { path: 'scripts/appliance-smoke.mjs', owner: 'local' },
  { path: 'scripts/appliance-dev.sh', owner: 'local' },
  { path: 'scripts/dev-local.ts', owner: 'local' },

  { path: 'scripts/gcp-deploy.sh', owner: 'cloud' },
  { path: 'scripts/gcp-setup.sh', owner: 'cloud' },
  { path: 'scripts/gcp-toggle.sh', owner: 'cloud' },
  { path: 'scripts/gcp-worker.sh', owner: 'cloud' },
  { path: 'scripts/gcp-code-worker.sh', owner: 'cloud' },
  { path: 'scripts/gcp-compute-worker.sh', owner: 'cloud' },
  { path: 'scripts/gcp-least-privilege-sa.sh', owner: 'cloud' },
  { path: 'scripts/gcp-origin-lock.sh', owner: 'cloud' },
  { path: 'scripts/gcp-security-evidence.sh', owner: 'cloud' },
  { path: 'scripts/sync-cf-origin-lock.sh', owner: 'cloud' },
  { path: 'scripts/sync-cf-origin-secret.sh', owner: 'cloud' },
  { path: 'scripts/heroku-start.mjs', owner: 'cloud' },
  {
    path: 'scripts/plans-move-completed.mjs',
    owner: 'cloud',
    why: 'Files closed plans into the private archive, which the public repository does not carry.',
  },
  {
    path: 'scripts/demo/',
    owner: 'cloud',
    why: 'Rehearsal scripts for hosted demos, written against routes that have since moved.',
  },
  {
    path: 'scripts/release.mjs',
    owner: 'core',
    why: "Named for Heroku's release phase and not owned by it: the appliance's own migrate service runs this same script to bring a database up before the API starts. Classifying it cloud would have deleted it from the product that needs it to boot.",
  },

  // One-off migrations and codemods live here while they are still needed, and
  // are deleted once they are not. The `delete` owner is for a file on its way
  // out, not a permanent category — an empty run of it means the tree is clean.
  {
    path: 'scripts/106-cleanup-seeded-artifacts.ts',
    owner: 'development',
    why: 'Not spent like its neighbours: CONTRIBUTING.md and the scripts README document it as a dry-run-first tool for stripping pre-registry rows from a database an operator manages, and it imports the live platform registry to know what to strip.',
  },
  {
    path: 'scripts/backfill-memory-derived-indexes.ts',
    owner: 'development',
    why: 'Not dead like its neighbours: a memory-store test imports it, so deleting it at the cut would take that test with it.',
  },
];

/**
 * Who owns an environment variable.
 *
 * Configuration is not a file, so the path rules above cannot reach it, and it
 * is the surface where a boundary leaks quietest: a key the local edition has
 * no plane for still reads as ordinary configuration, and a key it silently
 * ignores is worse than one it refuses.
 *
 * `ENTERPRISE_ONLY_ENV_KEYS` stays the authority for the keys it names — it is
 * what `findLocalAuthConfigViolations` enforces at boot — and
 * `ownershipEnv.test.ts` asserts this agrees with it rather than restating it.
 */
/**
 * Cloud-owned keys that code surviving the cut still reads today.
 *
 * Identity, admission and the hosted edge are planes P2 moves behind extension
 * contracts (§4.2–§4.4). Until it does, the auth plugin, the client-IP check
 * and the credential wrapper read hosted configuration directly, and a guard
 * asserting otherwise would be asserting the future.
 *
 * Named rather than tolerated: a *new* cloud key read by surviving code fails
 * `ownershipEnv.test.ts`, and this list is the work P2 has to finish.
 */
export const ENV_CLOUD_KEYS_READ_BEFORE_EXTRACTION: readonly string[] = [
  // ── Identity (§4.2) ─────────────────────────────────────────────────────
  // The server's bearer-token plane is extracted: `TokenVerification` is
  // supplied by the composition, and every `AUTH0_*` read the API request path
  // makes now lives in the hosted root's own module. What remains are the two
  // other places §4.2's responsibilities are answered.
  //
  // The web-session keys are gone from this list, and the guard's name says why
  // it could happen: they were excused while §4.5's web overlay did not exist.
  // It does. `AUTH0_*` and the Turnstile site key are read only by `apps/web`,
  // which is the hosted application — Train 2 gave the local edition its own in
  // `apps/web-local` — so every reader is `cloud` and no excuse is needed.
];

/**
 * Files that still reach across the cut, and the phase that closes each.
 *
 * These are not exceptions to the boundary; they are the boundary's remaining
 * work, and Train 2 exists because they are true. Naming them keeps the
 * coherence guard useful in the meantime: a *new* reach across the cut fails,
 * while these two known structures stay visible as a list that P1 and P2 empty
 * rather than as a guard nobody can turn on.
 */
export const CUT_REACHES_PENDING_EXTRACTION: ReadonlyArray<{ from: string; why: string }> = [];

/**
 * Configuration that still names paths the cut deletes, and what closes each.
 *
 * Unlike an import, a reference in configuration breaks nothing until somebody
 * runs the thing — which is why `scripts/release.mjs` could be classified
 * `cloud` while the appliance's migrate service ran it, with every other guard
 * green. A reference the cut's own transforms remove does not belong here; an
 * entry is real pending work, and the guard fails when it stops being.
 */
export const CUT_REFERENCES_PENDING_EXTRACTION: ReadonlyArray<{ from: string; why: string }> = [];

export const ENV_OWNERSHIP: Readonly<Record<string, OwnershipClass>> = {
  // Engine
  DATABASE_URL: 'core',
  REDIS_URL: 'core',
  PORT: 'core',
  PHOENIX_SERVER_ENTRY: 'core',
  HOST: 'core',
  LOG_LEVEL: 'core',
  MCP_PORT: 'core',
  DB_MAX_CONNECTIONS: 'core',
  DB_IDLE_TIMEOUT: 'core',
  DB_CONNECT_TIMEOUT: 'core',
  DB_SSL: 'core',
  DEFAULT_TIMEOUT_MS: 'core',
  EXECUTOR_CONCURRENCY: 'core',
  CORS_ORIGIN: 'core',
  API_BASE_URL: 'core',
  WEB_BASE_URL: 'core',
  DEFAULT_TENANT_ID: 'core',
  NEXT_PUBLIC_TENANT_ID: 'core',
  JWT_SECRET: 'core',

  // Model and tool providers. Core because the product is BYOK in either
  // edition; the appliance keeps them in the database rather than the
  // environment, which is where they are entered, not who owns the key.
  ANTHROPIC_API_KEY: 'core',
  OPENAI_API_KEY: 'core',
  GEMINI_API_KEY: 'core',
  OPENROUTER_API_KEY: 'core',
  FIREWORKS_API_KEY: 'core',
  XAI_API_KEY: 'core',
  BRAVE_SEARCH_API_KEY: 'core',
  JINA_API_KEY: 'core',

  // Hosted identity — the plane the local edition withholds.
  AUTH0_DOMAIN: 'cloud',
  AUTH0_AUDIENCE: 'cloud',
  AUTH0_CLIENT_ID: 'cloud',
  AUTH0_CLIENT_SECRET: 'cloud',
  AUTH0_CLI_CLIENT_ID: 'cloud',
  AUTH0_BASE_URL: 'cloud',
  AUTH0_SECRET: 'cloud',
  AUTH0_MGMT_CLIENT_ID: 'cloud',
  AUTH0_MGMT_CLIENT_SECRET: 'cloud',

  // Hosted authorization.

  // Mail is core, and the tempting reading is the wrong one. `mailer.ts` is
  // enterprise and a cut deletes it — but it is not the only reader:
  // `aflow-executor-user` is core, runs in the appliance, and reads all of
  // these for the email operations an agent calls. Two readers, different
  // editions; the key belongs to the surviving one.
  EMAIL_ENABLED: 'core',
  SES_FROM_ADDRESS: 'core',
  SES_FROM_NAME: 'core',
  SES_SMTP_HOST: 'core',
  SES_SMTP_PORT: 'core',
  SES_SMTP_SECURE: 'core',
  SES_SMTP_USERNAME: 'core',
  SES_SMTP_PASSWORD: 'core',
  SES_MAX_SUBJECT_LENGTH: 'core',
  SES_MAX_CONTENT_BYTES: 'core',
  SES_CONFIGURATION_SET: 'core',
  SES_REPLY_TO: 'core',

  // Managed voice lane.
  LIVEKIT_URL: 'cloud',
  LIVEKIT_API_KEY: 'cloud',
  LIVEKIT_API_SECRET: 'cloud',
  VOICE_DEFAULT_AGENT_ID: 'cloud',

  // Engine knobs and provider endpoints.
  AI_AGENT_TURN_MAX_TIMEOUT_MS: 'core',
  AI_STREAM_IDLE_TIMEOUT_MS: 'core',
  AFLOW_MCP_LOCAL_AUTH_JSON: 'core',
  ORCHESTRATOR_CONSUMER_NAME: 'core',
  HOSTNAME: 'core',
  PHOENIX_PAYLOAD_DIR: 'core',
  REDIS_PASSWORD: 'core',
  REDIS_TLS_INSECURE: 'core',
  CREDENTIAL_ENCRYPTION_KEY: 'core',
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: 'core',
  CREDENTIAL_EXTRA_BASE_URL_ORIGINS: 'core',
  COACH_AUTO_REVIEW_ENABLED: 'core',
  AUTHZ_STRICT_ROUTE_VALIDATION: 'core',
  ENABLE_CONSOLE_TRACING: 'core',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'core',

  // Error reporting. Core because the readers are core — `packages/observability`
  // and the web app — and an operator pointing the appliance at their own
  // project is configuring their instance, not consuming a managed service.
  SENTRY_DSN: 'core',
  SENTRY_ENVIRONMENT: 'core',
  SENTRY_RELEASE: 'core',
  SENTRY_TRACES_SAMPLE_RATE: 'core',
  SENTRY_PROFILES_SAMPLE_RATE: 'core',

  // Object storage and the credential wrapping key. Core because the readers
  // are core — the payload store and the credential store are engine runtime,
  // both select a backend from configuration rather than from a build, and
  // both already prefer a local one. A self-hoster on GCP configures these the
  // same way the managed deployment does. Withholding the KMS arm in
  // particular would leave the public core with only a master key in process
  // memory, which is a worse default, not a smaller surface.
  GCP_PROJECT_ID: 'core',
  GCS_PAYLOAD_BUCKET: 'core',
  GOOGLE_APPLICATION_CREDENTIALS: 'core',
  CREDENTIAL_KMS_KEY: 'core',

  // Documented but read by nothing; `GCS_PAYLOAD_BUCKET` is the one the
  // payload store reads.
  GCS_BUCKET: 'cloud',

  // A shared secret between an instance's own front-end components and its
  // API — the web BFF and the MCP server set `X-Origin-Verify`, and the API
  // derives a real client IP from forwarded headers only when it matches.
  // Without it every browser user behind the BFF shares one rate-limit
  // bucket, which is as true of an appliance behind a reverse proxy as of the
  // hosted deployment. The `CF_` prefix records where it was first used; the
  // Cloudflare rule that also sends it is edge configuration, not a reader.
  CF_ORIGIN_SECRET: 'core',

  // The edge in front of the hosted API.
  CF_ORIGIN_LOCK_SECRET: 'cloud',
  TURNSTILE_SECRET_KEY: 'cloud',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'cloud',
  AUTH0_PREVIOUS_DOMAINS: 'cloud',

  // Managed voice lane. Speech and transcription use XAI_API_KEY (classified with
  // the other model keys). These name the voice dyno's tenant and its xAI voice.
  TTS_VOICE: 'cloud',
  TTS_LANGUAGE: 'cloud',
  TTS_SPEED: 'cloud',
  PHOENIX_API_KEY: 'cloud',
  PHOENIX_TENANT_ID: 'cloud',

  // Managed coding lane. Every one of these has exactly one reader and it is
  // `aflow-executor-code`.
  ANTHROPIC_BASE_URL: 'cloud',
  // Core, unlike the rest of the lane's configuration: the breaker has two
  // halves and the enqueue half lives in the orchestrator, which is core. A
  // build without the lane still has to refuse to schedule work for it.
  CODE_LANE_ENABLED: 'core',
  CODE_LANE_IMAGE: 'cloud',
  CODE_LANE_NETWORK: 'cloud',
  CODE_LANE_CPUS: 'cloud',
  CODE_LANE_MEMORY: 'cloud',
  CODE_LANE_PIDS_LIMIT: 'cloud',
  CODE_LANE_HOME_SIZE: 'cloud',
  CODE_LANE_TMP_SIZE: 'cloud',
  CODE_LANE_WORKSPACE_SIZE: 'cloud',
  CODE_LANE_COMMIT_AUTHOR_NAME: 'cloud',
  CODE_LANE_COMMIT_AUTHOR_EMAIL: 'cloud',
  CODE_BROKER_BIND_HOST: 'cloud',
  CODE_BROKER_PORT: 'cloud',
  CODE_EGRESS_PROXY_PORT: 'cloud',
  CODE_CHECK_COMMAND_TIMEOUT_MS: 'cloud',
  CODE_MODEL_FAILURE_BUDGET_MS: 'cloud',

  // Development tooling.
  ALLOW_SYSTEM_AGENT_EDIT: 'development',
  BACKGROUND_WORK_VERBOSE_LOGS: 'development',
  PERF_SLOW_QUERY_MS: 'development',
  PERF_SLOW_READ_MS: 'development',
  SENTRY_DEBUG: 'development',
  // The maintainers' pull-request App, read only by `scripts/create-pr.sh`.
  APP_ID: 'cloud',
  APP_PRIVATE_KEY: 'cloud',
  APP_PRIVATE_KEY_FILE: 'cloud',

  // Documented and read by nothing. Found by classifying rather than by
  // anybody noticing: an example file is where a removed option goes to be
  // remembered forever.
  AZURE_OPENAI_API_KEY: 'delete',
  AZURE_OPENAI_ENDPOINT: 'delete',
  OPENAI_BASE_URL: 'delete',
  OPENAI_API_VERSION: 'delete',
  GEMINI_NEXT_GEN_API_BASE_URL: 'delete',
  FEATURE_STREAMING_AI: 'delete',
  FEATURE_TOOL_CALLING: 'delete',

  USE_MOCK_CONTEXT: 'development',
};
