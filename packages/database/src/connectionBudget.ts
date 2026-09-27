/**
 * How one Postgres server's connections are divided across the fleet.
 *
 * `poolMax` is per **process**, and processes are created in two places that
 * cannot see each other: an autoscaler ceiling in a deploy config, and a
 * launcher profile that fans one container out into several services. Both
 * multiply the pool, so the quantity that has to fit the database — the sum
 * over every process that may exist at once — appears in no single file, and
 * a default that looks modest per process is not.
 *
 * That default was 20. At two Cloud Run instances plus a worker host running
 * seven services, it described a fleet asking for well over a hundred
 * connections from a database that offers 25.
 *
 * So the split is declared rather than defaulted, and declared as *shares*:
 * weights say which services matter most, and the arithmetic below fits them
 * to whatever the server actually offers. Moving to a larger instance is then
 * one number — `DB_SERVER_MAX_CONNECTIONS`, or the constant it defaults to —
 * and every pool re-derives from it.
 */

import { SUPERUSER_RESERVED_CONNECTIONS, OPERATIONAL_CONNECTION_RESERVE } from './poolHeadroom.js';

/**
 * `max_connections` on the database the fleet shares.
 *
 * `db-f1-micro` offers 25. The `max_connections` flag is settable on Cloud SQL
 * (min 14), but memory is the binding limit rather than policy — this tier has
 * 614 MiB and every backend costs several MB of it — so in practice the number
 * moves by changing instance tier.
 *
 * Changing it HERE is what reaches the whole fleet: the constant travels in the
 * image, so one deploy resizes every host. `DB_SERVER_MAX_CONNECTIONS` overrides
 * it per host, which is a break-glass rather than a fleet lever — the VM
 * launchers pass a fixed env list and would not carry it. A host left behind is
 * not silent: `serverCapacityDrift` reports it against the server's real
 * `max_connections` at boot.
 */
export const DEFAULT_SERVER_MAX_CONNECTIONS = 25;

/**
 * Each service's relative claim on the servable budget.
 *
 * Relative, not absolute: absolute numbers have to be re-tuned by hand every
 * time the database or the topology changes, and the tuning is invisible
 * afterwards. A weight says something that stays true across tiers — the API
 * and the orchestrator carry the request path and the single writer, the
 * executors wake up to write a result and go back to sleep.
 */
export const SERVICE_POOL_WEIGHTS = {
  server: 6,
  orchestrator: 6,
  'executor-ai': 3,
  'executor-api': 3,
  'executor-memory': 3,
  'executor-user': 1,
  'executor-ui': 1,
  'executor-mcp': 1,
  'executor-compute': 2,
  'executor-code': 2,
} as const;

export type PooledService = keyof typeof SERVICE_POOL_WEIGHTS;

/**
 * The production hosts: which pool-opening services each runs, and how many
 * of each may exist at once.
 *
 * The instance count is declared here rather than read from the environment
 * because every host has to reach the SAME plan. `PHOENIX_MAX_INSTANCES` is
 * set on the autoscaling service and nowhere else, so a worker VM reading its
 * own environment sees no ceiling, assumes one API instance, and hands its
 * seven processes a larger share than the API host — computed from the same
 * budget — was told to leave it. Both hosts then report that they fit, and
 * the fleet is over the database by the difference.
 *
 * Only production profiles appear. `all`, `ai-worker` and `web-core-legacy`
 * exist for development against a local database that is not scarce, and
 * pretending to budget them would put fictional demand in the worst case.
 */
export interface PooledHost {
  services: readonly PooledService[];
  /** Processes of this host that may run at once — an autoscaler ceiling. */
  instances: number;
}

/**
 * The weights above are per process, and a process counts as holding ONE pool.
 * A service that builds a second draws twice what it was allocated while every
 * report still shows the allocated figure — the server did exactly that, with
 * a context pool alongside the module singleton its health probe reached for.
 * `poolSizing.test.ts` holds that line.
 */

export const POOLED_FLEET: Record<string, PooledHost> = {
  // Kept in step with `--max-instances` in cloudbuild.yaml and gcp-setup.sh,
  // which a guard test asserts.
  'web-core': { services: ['server'], instances: 2 },
  worker: {
    services: [
      'orchestrator',
      'executor-ai',
      'executor-api',
      'executor-user',
      'executor-memory',
      'executor-ui',
      'executor-mcp',
    ],
    instances: 1,
  },
  'compute-worker': { services: ['executor-compute'], instances: 1 },
  'code-worker': { services: ['executor-code'], instances: 1 },
};

export interface PoolPlan {
  /** Connections each service's pool may open, keyed by service. */
  perService: Record<PooledService, number>;
  /** What the whole fleet holds with every pool full. */
  fleetWorstCase: number;
  /** Connections the fleet may use in total, after reserves. */
  budget: number;
  /** Whether the plan fits inside that budget. */
  fits: boolean;
  serverMaxConnections: number;
}

/**
 * Instance counts to plan against, overriding what `POOLED_FLEET` declares.
 *
 * For asking what a different topology would cost — never for letting a host
 * describe the fleet from where it happens to be standing.
 */
export type InstanceCounts = Partial<Record<string, number>>;

export function poolPlan(
  opts: {
    serverMaxConnections?: number;
    instances?: InstanceCounts;
  } = {},
): PoolPlan {
  const serverMaxConnections = opts.serverMaxConnections ?? DEFAULT_SERVER_MAX_CONNECTIONS;
  const budget =
    serverMaxConnections - SUPERUSER_RESERVED_CONNECTIONS - OPERATIONAL_CONNECTION_RESERVE;

  const instancesOf = (profile: string): number =>
    Math.max(1, Math.floor(opts.instances?.[profile] ?? POOLED_FLEET[profile]?.instances ?? 1));

  // Weight summed over processes, not over services: two Cloud Run instances
  // of the API are two pools, and the database is asked for both.
  let totalWeight = 0;
  for (const [profile, host] of Object.entries(POOLED_FLEET)) {
    const count = instancesOf(profile);
    for (const service of host.services) totalWeight += SERVICE_POOL_WEIGHTS[service] * count;
  }

  const perService = {} as Record<PooledService, number>;
  let fleetWorstCase = 0;
  for (const [profile, host] of Object.entries(POOLED_FLEET)) {
    const count = instancesOf(profile);
    for (const service of host.services) {
      // Floored, then floored again at one: a share that rounds to nothing
      // still has to be able to open a connection, and rounding down is what
      // keeps the sum inside the budget rather than just near it.
      const share = (budget * SERVICE_POOL_WEIGHTS[service]) / Math.max(1, totalWeight);
      const size = Math.max(1, Math.floor(share));
      perService[service] = size;
      fleetWorstCase += size * count;
    }
  }

  return {
    perService,
    fleetWorstCase,
    budget,
    fits: fleetWorstCase <= budget,
    serverMaxConnections,
  };
}

/** The pool size for one service, or `undefined` if it opens none in production. */
export function poolMaxForService(
  service: string,
  opts?: Parameters<typeof poolPlan>[0],
): number | undefined {
  if (!(service in SERVICE_POOL_WEIGHTS)) return undefined;
  return poolPlan(opts).perService[service as PooledService];
}

/** `DB_SERVER_MAX_CONNECTIONS`, or the tier default when unset or unusable. */
export function serverMaxConnectionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env['DB_SERVER_MAX_CONNECTIONS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SERVER_MAX_CONNECTIONS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SERVER_MAX_CONNECTIONS;
}

/**
 * Whether the autoscaler ceiling this host was given matches the one the split
 * was computed from.
 *
 * The ceiling is not read for sizing — a host that sized from its own
 * environment would disagree with every host the variable was not set on. But
 * where it IS set it is the deploy config talking, so a mismatch means the
 * ceiling moved and the declaration did not follow, and the fleet is being
 * planned for a size it no longer is.
 */
export function instanceCeilingDrift(opts: {
  profile: string;
  configured: string | undefined;
}): string | null {
  const declared = POOLED_FLEET[opts.profile]?.instances;
  if (declared === undefined) return null;
  const raw = opts.configured;
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) === declared) return null;
  return (
    `[db] connection budget plans for ${String(declared)} ${opts.profile} instance(s) but this ` +
    `host is capped at ${String(Math.floor(n))}. Update POOLED_FLEET['${opts.profile}'].instances ` +
    `so every host sizes its pool against the same fleet.`
  );
}
