/**
 * Edition descriptor — which product this process is.
 *
 * Aflow ships as two editions from one source tree: the multi-tenant hosted
 * product, and a single-user local appliance. The descriptor is what the two
 * differ by; it is resolved once at process start from server-owned
 * configuration and is never derived from a request.
 *
 * The descriptor decides control-plane composition only. Execution contracts —
 * stream messages, hot-state keys, payload namespaces, `tenantId` on every
 * message — are identical in both editions.
 */
import { z } from 'zod';

// ============================================================================
// Edition
// ============================================================================

export const EditionIdSchema = z.enum([
  /** Multi-tenant hosted product: Auth0 identity, memberships, admission. */
  'enterprise',
  /** Single-user local appliance: one fixed tenant, one local owner. */
  'community-local',
]);
export type EditionId = z.infer<typeof EditionIdSchema>;

/**
 * Which edition a surface belongs to.
 *
 * `core` surfaces exist in both editions and are the ones the public core
 * repository will eventually own. `enterprise` surfaces exist only in the
 * hosted product and are the ones a private extension will own.
 */
export const EditionTierSchema = z.enum(['core', 'enterprise']);
export type EditionTier = z.infer<typeof EditionTierSchema>;

// ============================================================================
// Descriptor
// ============================================================================

export const AuthProviderIdSchema = z.enum(['auth0', 'local-instance']);
export type AuthProviderId = z.infer<typeof AuthProviderIdSchema>;

/**
 * How the process resolves the tenant for a request.
 *
 * `fixed` does not remove the tenant from any contract — it pins resolution to
 * one immutable value and rejects a request that names another.
 */
export const TenancyModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('multi') }),
  z.object({ mode: z.literal('fixed'), tenantId: z.string().uuid() }),
]);
export type TenancyMode = z.infer<typeof TenancyModeSchema>;

export const ExposurePolicySchema = z.object({
  /**
   * How far this process is reachable, which is not always the interface it
   * binds.
   *
   * - `loopback` — binds the loopback interface. The host is the boundary.
   * - `container` — binds every interface inside its own network namespace.
   *   The boundary is the namespace plus how the port was published; a
   *   process that bound loopback here would be unreachable even from the
   *   loopback port its own operator published.
   * - `any` — published to a network. Requires TLS in front of it.
   */
  bind: z.enum(['loopback', 'container', 'any']),
  /** Whether the deployment terminates TLS in front of this process. */
  requireTls: z.boolean(),
});
export type ExposurePolicy = z.infer<typeof ExposurePolicySchema>;

/**
 * Whether a deployment has a compute executor able to serve `compute.*`.
 *
 * Distinct from the per-space compute policy, which is an operator's decision
 * about a runtime that exists. This says whether one exists at all — and an
 * operator switching the policy on where it does not gets a workspace that
 * permits sandboxed code and no way to run it, which is the same dead end the
 * policy gate exists to prevent, one layer along.
 *
 * The sandbox needs the host Docker daemon, so the appliance ships without it
 * and the profile that adds it declares itself here.
 */
export const ComputeRuntimeSchema = z.enum(['present', 'absent']);
export type ComputeRuntime = z.infer<typeof ComputeRuntimeSchema>;

/**
 * Whether sandboxed code can run here, as the two questions it is.
 *
 * `composed` is what the deployment carries, resolved once at boot. `executor` is
 * whether one is answering, read from its heartbeat at the moment of asking;
 * `unknown` means Redis could not be reached to ask.
 *
 * Kept apart rather than reduced to one flag: a policy refusal rests on the
 * claim, which does not flap, while an operator needs the observation, which
 * does.
 */
/**
 * Whether a deployment carries a managed coding lane able to serve `code.*`.
 *
 * The lane is a separate executor with its own host, egress policy and
 * credential brokerage. The local appliance ships without it; its answer to
 * coding work is the host lane on the operator's own machine. Readiness that
 * asks for a coding-lane key or a repo designation where no lane exists sends
 * the operator to a fix that cannot fix anything.
 */
export const CodeLaneSchema = z.enum(['present', 'absent']);
export type CodeLane = z.infer<typeof CodeLaneSchema>;

/**
 * The composed coding lane, readable without validating the rest of the
 * environment, for library code running after boot resolved the descriptor.
 */
export function codeLaneComposed(env: NodeJS.ProcessEnv = process.env): CodeLane {
  const override = env['PHOENIX_CODE_LANE']?.trim();
  if (override === 'present' || override === 'absent') return override;
  const edition = EditionIdSchema.safeParse(env['PHOENIX_EDITION']?.trim() || 'enterprise');
  return edition.success && edition.data === 'community-local' ? 'absent' : 'present';
}

/**
 * Whether a deployment carries a host lane — a paired machine able to serve
 * `host.*`.
 *
 * Keyed on the host credential rather than on an edition label, because that is
 * what actually decides it: the credential is generated at an appliance's first
 * boot, and a deployment without one has no lane for a machine to pair with. A
 * hosted instance therefore answers `absent` without anyone having to remember
 * to tier the surface.
 */
export const HostLaneSchema = z.enum(['present', 'absent']);
export type HostLane = z.infer<typeof HostLaneSchema>;

/**
 * The composed host lane, readable without validating the rest of the
 * environment, for library code running after boot resolved the descriptor.
 */
export function hostLaneComposed(env: NodeJS.ProcessEnv = process.env): HostLane {
  const credential = env['PHOENIX_HOST_REDIS_PASSWORD']?.trim();
  return credential !== undefined && credential !== '' ? 'present' : 'absent';
}

export const ComputeAvailabilitySchema = z.object({
  composed: ComputeRuntimeSchema,
  executor: z.enum(['up', 'down', 'unknown']),
});
export type ComputeAvailability = z.infer<typeof ComputeAvailabilitySchema>;

export const EditionDescriptorSchema = z.object({
  edition: EditionIdSchema,
  authProvider: AuthProviderIdSchema,
  tenancy: TenancyModeSchema,
  exposure: ExposurePolicySchema,
  computeRuntime: ComputeRuntimeSchema,
  codeLane: CodeLaneSchema,
  hostLane: HostLaneSchema,
});
export type EditionDescriptor = z.infer<typeof EditionDescriptorSchema>;

/**
 * What a client is told about the edition serving it.
 *
 * `surfaces` is the composed surface list, derived from the same registry the
 * server registers from — so a client hiding a control because its surface is
 * absent cannot drift from what the server actually serves.
 *
 * `lanes` carries the descriptor's own lane composition, because a surface name
 * cannot answer for a lane: a route registered in both editions exists in both
 * and declines at runtime, so a client asking after the surface is told yes and
 * offers work nothing here can execute.
 */
export const EditionSummarySchema = z.object({
  id: EditionIdSchema,
  surfaces: z.array(z.string()),
  lanes: z.object({ codeLane: CodeLaneSchema, hostLane: HostLaneSchema }),
});
export type EditionSummary = z.infer<typeof EditionSummarySchema>;

// ============================================================================
// Resolution
// ============================================================================

/**
 * Tenant the local appliance runs as when the operator has not pinned one.
 *
 * A single-user instance has no tenant to choose, so a well-known value lets a
 * fresh appliance boot before anything has generated one. Bootstrap writes this
 * row; `PHOENIX_LOCAL_TENANT_ID` overrides it for an instance restored from a
 * backup that carries a different id.
 */
export const LOCAL_EDITION_TENANT_ID = '00000000-0000-4000-8000-0000000ed1c0';

/**
 * The local appliance's single owner.
 *
 * Paired with {@link LOCAL_EDITION_TENANT_ID}: bootstrap writes both rows, and
 * `PHOENIX_LOCAL_OWNER_ID` overrides this one for a restored instance.
 */
export const LOCAL_EDITION_OWNER_ID = '00000000-0000-4000-8000-0000000ed1c1';

/**
 * Identity-plane configuration the local edition composes no reader for.
 */
export const ENTERPRISE_IDENTITY_ENV_KEYS = [
  'AUTH0_DOMAIN',
  'AUTH0_AUDIENCE',
  'AUTH0_CLIENT_ID',
] as const;

/**
 * Whether the environment carries identity-provider configuration.
 *
 * Asked by a build that composes no provider, where the answer decides whether
 * a development bypass may open. A process that cannot use this configuration
 * must not treat its presence as absence: the operator has said a directory
 * is in front of this deployment, and anonymous access is the one outcome that
 * cannot be squared with that.
 */
export function hasIdentityProviderConfig(env: NodeJS.ProcessEnv): boolean {
  return ENTERPRISE_IDENTITY_ENV_KEYS.some((key) => isSet(env[key]));
}

/** Every environment key that configures a plane the local edition withholds. */
export const ENTERPRISE_ONLY_ENV_KEYS: readonly string[] = [...ENTERPRISE_IDENTITY_ENV_KEYS];

export interface EditionConfigViolation {
  key: string;
  message: string;
}

export class EditionConfigError extends Error {
  constructor(readonly violations: EditionConfigViolation[]) {
    super(
      `Edition configuration is not usable:\n${violations
        .map((v) => `  - ${v.key}: ${v.message}`)
        .join('\n')}`,
    );
    this.name = 'EditionConfigError';
  }
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * A variable present but empty is unset, not a value. `??` alone keeps `''`,
 * which is how a stray `KEY=` in an env file becomes an id.
 */
function configured(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? fallback : trimmed;
}

/**
 * Resolve the descriptor from the environment.
 *
 * An unset `PHOENIX_EDITION` resolves to `enterprise`, so a deployment that
 * predates the descriptor keeps its current composition.
 *
 * Throws `EditionConfigError` rather than degrading: an edition that half
 * applies is the one failure mode this seam exists to prevent — a local
 * appliance that silently kept an Auth0 issuer would accept tokens the product
 * claims it cannot.
 */
export function resolveEditionDescriptor(env: NodeJS.ProcessEnv = process.env): EditionDescriptor {
  const violations: EditionConfigViolation[] = [];

  const rawEdition = env['PHOENIX_EDITION']?.trim() ?? 'enterprise';
  const parsedEdition = EditionIdSchema.safeParse(rawEdition);
  if (!parsedEdition.success) {
    throw new EditionConfigError([
      {
        key: 'PHOENIX_EDITION',
        message: `Unknown edition "${rawEdition}". Expected one of: ${EditionIdSchema.options.join(', ')}.`,
      },
    ]);
  }
  const edition = parsedEdition.data;

  if (edition === 'enterprise') {
    return EditionDescriptorSchema.parse({
      edition,
      authProvider: 'auth0',
      tenancy: { mode: 'multi' },
      exposure: {
        bind: 'any',
        requireTls: env['NODE_ENV'] === 'production',
      },
      // The hosted deployment runs the sandbox on its own host, reached through
      // the job stream rather than by sitting beside the orchestrator — so it
      // is present by default, and can be declared absent.
      //
      // What the deployment carries, not what is answering:
      // `gcp:compute-worker:stop` leaves this reading `present` with nothing
      // running, which is what `ComputeAvailability.executor` is for.
      computeRuntime: env['PHOENIX_COMPUTE_RUNTIME']?.trim() === 'absent' ? 'absent' : 'present',
      codeLane: codeLaneComposed(env),
      hostLane: hostLaneComposed(env),
    });
  }

  // ---- community-local ----------------------------------------------------

  // Configuration for a plane this edition does not compose would otherwise sit
  // there reading as active.
  for (const key of ENTERPRISE_IDENTITY_ENV_KEYS) {
    if (isSet(env[key])) {
      violations.push({
        key,
        message:
          'Not used by the local edition, which authenticates with a generated instance identity. Remove it, or run the enterprise edition.',
      });
    }
  }

  const tenantId = configured(env['PHOENIX_LOCAL_TENANT_ID'], LOCAL_EDITION_TENANT_ID);
  if (!z.string().uuid().safeParse(tenantId).success) {
    violations.push({
      key: 'PHOENIX_LOCAL_TENANT_ID',
      message: `Must be a UUID. Received "${tenantId}".`,
    });
  }

  const requestedBind = env['PHOENIX_BIND']?.trim();
  const parsedBind = ExposurePolicySchema.shape.bind.safeParse(requestedBind ?? 'loopback');
  if (!parsedBind.success) {
    violations.push({
      key: 'PHOENIX_BIND',
      message: `Unknown value "${String(requestedBind)}". Expected one of: ${ExposurePolicySchema.shape.bind.options.join(', ')}.`,
    });
  }
  const bind = parsedBind.success ? parsedBind.data : 'loopback';
  const requireTls = env['PHOENIX_REQUIRE_TLS']?.trim() === 'true';

  // The appliance authenticates the browser with a session that only the
  // boundary in front of it protects. Publishing it to a network without TLS
  // would put that session on the wire, so the incompatible combination fails
  // closed here rather than at whichever request first carries it. `container`
  // is not that case: its boundary is the namespace and the published port.
  if (bind === 'any' && !requireTls) {
    violations.push({
      key: 'PHOENIX_BIND',
      message:
        'Publishing the local edition beyond loopback requires PHOENIX_REQUIRE_TLS=true and a TLS terminator in front of it.',
    });
  }

  if (violations.length > 0) throw new EditionConfigError(violations);

  return EditionDescriptorSchema.parse({
    edition,
    authProvider: 'local-instance',
    tenancy: { mode: 'fixed', tenantId },
    exposure: { bind, requireTls },
    // A claim the deployment makes, and the appliance's compose makes it: running
    // code is one of the capabilities this product exists to offer, so the
    // sandbox ships in the base artifact rather than behind an opt-in. The
    // default stays `absent` for everything else that composes this edition
    // without a sandbox — a policy switch for a runtime that is not there is
    // worse than no switch.
    computeRuntime: env['PHOENIX_COMPUTE_RUNTIME']?.trim() === 'present' ? 'present' : 'absent',
    // The appliance composes no coding-lane executor; the host lane is the local
    // edition's coding and command lane.
    codeLane: codeLaneComposed(env),
    hostLane: hostLaneComposed(env),
  });
}

let resolvedForProcess: EditionDescriptor | undefined;

/**
 * The descriptor this process runs as, resolved once.
 *
 * For library code that composes behaviour per edition after boot and holds no
 * server instance to read it from. Memoized so every such surface answers with
 * the descriptor the boot resolved rather than an environment mutated since.
 */
export function processEditionDescriptor(): EditionDescriptor {
  resolvedForProcess ??= resolveEditionDescriptor();
  return resolvedForProcess;
}

/** Whether a surface at `tier` is composed into a process running `edition`. */
export function isTierEnabled(edition: EditionId, tier: EditionTier): boolean {
  return tier === 'core' || edition === 'enterprise';
}
