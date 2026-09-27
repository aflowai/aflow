/**
 * Whether the connection pool fits the database it points at.
 *
 * The pool is per **process**, and the number of processes is set somewhere
 * else entirely — an autoscaler ceiling in a deploy config. So the quantity
 * that has to fit, `poolMax x instances`, is never visible in one place, and
 * raising either side alone looks free.
 *
 * It is not, and the failure does not surface at the service that grew: the
 * connections are simply gone, and whatever asks for one next fails instead —
 * typically the deploy-time migration job, which takes the whole release with
 * it. Hence a check at boot, where the two numbers can still be compared.
 */

/**
 * Connections a Postgres server keeps for superusers, which ordinary clients
 * cannot take. Cloud SQL leaves the `superuser_reserved_connections` default.
 */
export const SUPERUSER_RESERVED_CONNECTIONS = 3;

/**
 * Connections to keep free for work that arrives outside the serving path —
 * the migration job above all, which runs at deploy time and fails the whole
 * release when it cannot connect.
 */
export const OPERATIONAL_CONNECTION_RESERVE = 3;

export interface PoolHeadroom {
  /** Connections the serving fleet may use in total. */
  budget: number;
  /** What it would use with every pool full. */
  worstCase: number;
  fits: boolean;
  /** The largest `poolMax` that fits at this instance count, at least 1. */
  recommendedPoolMax: number;
}

export function assessPoolHeadroom(opts: {
  /** `max` per pool, per process. */
  poolMax: number;
  /** Processes that may run at once — the autoscaler ceiling. */
  instances: number;
  /** The server's `max_connections`. */
  maxConnections: number;
  /** Connections held by other services against the same database. */
  otherServices?: number;
}): PoolHeadroom {
  const other = opts.otherServices ?? 0;
  const budget =
    opts.maxConnections - SUPERUSER_RESERVED_CONNECTIONS - OPERATIONAL_CONNECTION_RESERVE - other;
  const worstCase = opts.poolMax * opts.instances;
  return {
    budget,
    worstCase,
    fits: worstCase <= budget,
    recommendedPoolMax: Math.max(1, Math.floor(budget / Math.max(1, opts.instances))),
  };
}

/** The message to log when it does not fit. Separated so it can be asserted. */
export function poolHeadroomWarning(
  opts: Parameters<typeof assessPoolHeadroom>[0],
  headroom: PoolHeadroom,
): string {
  return (
    `[db] connection pool may exceed the database: ${String(opts.instances)} instances x ` +
    `${String(opts.poolMax)} connections = ${String(headroom.worstCase)}, but only ` +
    `${String(headroom.budget)} of ${String(opts.maxConnections)} are available after reserves. ` +
    `Lower DB_MAX_CONNECTIONS to ${String(headroom.recommendedPoolMax)}, reduce the instance ` +
    `ceiling, or raise the database's max_connections.`
  );
}

/** Where the fleet figure came from, which decides how much it is worth. */
export type FleetBasis = 'configured' | 'observed' | 'unknown';

export interface FleetUsage {
  value: number;
  basis: FleetBasis;
}

/**
 * What to treat as the rest of the fleet's usage.
 *
 * This is a **worst-case** check, and worst case is a fact about the
 * deployment's topology rather than anything one process can watch: a reading
 * taken here is taken at boot, which is the quietest moment this process will
 * ever see, so it systematically reports less than the fleet's peak. Measured
 * against production, the gap is large — the same fleet sat near 4 while idle
 * and near 8 under agent load.
 *
 * So a configured value wins outright, and a reading is kept only as a floor
 * for deployments that state nothing. The basis travels with the number so the
 * warning can say which one it is standing on, because an operator reading
 * "fits" needs to know whether that was checked against a peak or against a
 * quiet instant.
 */
export function resolveOtherServiceConnections(opts: {
  configured?: string | undefined;
  measured?: number | null;
}): FleetUsage {
  const raw = opts.configured;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return { value: n, basis: 'configured' };
  }
  const m = opts.measured;
  if (typeof m === 'number' && Number.isFinite(m) && m >= 0) {
    return { value: m, basis: 'observed' };
  }
  return { value: 0, basis: 'unknown' };
}

/** What to append to the warning so its basis is not left to the reader. */
export function fleetBasisNote(basis: FleetBasis): string {
  switch (basis) {
    case 'configured':
      return 'Other services are taken from DB_FLEET_RESERVED_CONNECTIONS.';
    case 'observed':
      return (
        'Other services were counted at boot, which is this process at its ' +
        'quietest — set DB_FLEET_RESERVED_CONNECTIONS to the fleet peak to ' +
        'check against the worst case instead.'
      );
    case 'unknown':
      return (
        'Other services could not be counted and were assumed to hold ' +
        'nothing, so this compares against the whole database.'
      );
  }
}

/**
 * Whether the capacity the split was computed from is the capacity the server
 * actually has.
 *
 * The whole plan hangs off one declared number, so the number being wrong is
 * the one failure that reaches every pool at once — and it is wrong in both
 * directions for the same reason, an instance tier changed without the
 * declaration following it. Too high hands out connections the server will
 * refuse; too low caps the fleet far under a database somebody already paid
 * to enlarge, with nothing anywhere reporting it.
 */
export function serverCapacityDrift(opts: {
  declared: number;
  actual: number;
}): { drifted: boolean; message: string } | null {
  if (opts.declared === opts.actual) return null;
  const direction =
    opts.declared > opts.actual
      ? `pools were sized for more connections than exist, so the fleet can exhaust the database`
      : `pools are sized for a smaller database than this one, so the fleet is capped below what it could use`;
  return {
    drifted: true,
    message:
      `[db] connection budget assumes max_connections=${String(opts.declared)} but the ` +
      `server reports ${String(opts.actual)} — ${direction}. Set ` +
      `DB_SERVER_MAX_CONNECTIONS=${String(opts.actual)} (or update ` +
      `DEFAULT_SERVER_MAX_CONNECTIONS) so the split matches the instance.`,
  };
}
