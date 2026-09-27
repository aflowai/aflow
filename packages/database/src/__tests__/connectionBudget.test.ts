/**
 * The split has to fit the database it is computed for, at every tier and at
 * every instance ceiling — that is the whole point of deriving it rather than
 * writing pool sizes down per host.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  instanceCeilingDrift,
  poolPlan,
  poolMaxForService,
  serverMaxConnectionsFromEnv,
  SERVICE_POOL_WEIGHTS,
  POOLED_FLEET,
  DEFAULT_SERVER_MAX_CONNECTIONS,
} from '../connectionBudget.js';

/** Production today: two Cloud Run instances, one of each worker VM. */
const PROD = { instances: { 'web-core': 2 } };

describe('poolPlan', () => {
  it('fits the db-f1-micro the fleet actually runs against', () => {
    const plan = poolPlan(PROD);
    expect(plan.serverMaxConnections).toBe(25);
    expect(plan.budget).toBe(19);
    expect(plan.fits).toBe(true);
    expect(plan.fleetWorstCase).toBeLessThanOrEqual(plan.budget);
  });

  it('replaces the default that caused the exhaustion', () => {
    // Every process took `?? 20`: two API instances plus a seven-service
    // worker host asked for 180 connections from a database offering 25.
    const old = 20 * (2 + POOLED_FLEET['worker']!.services.length + 1 + 1);
    expect(old).toBeGreaterThan(poolPlan(PROD).budget);
    expect(poolPlan(PROD).fleetWorstCase).toBeLessThan(old);
  });

  it('fits at every tier a Cloud SQL instance might offer', () => {
    for (const cap of [25, 50, 100, 200, 400, 1000]) {
      const plan = poolPlan({ ...PROD, serverMaxConnections: cap });
      expect(plan.fits, `capacity ${String(cap)} does not fit`).toBe(true);
    }
  });

  it('fits however high the API ceiling is raised', () => {
    for (const instances of [1, 2, 3, 5, 10]) {
      const plan = poolPlan({ serverMaxConnections: 200, instances: { 'web-core': instances } });
      expect(plan.fits, `${String(instances)} instances do not fit`).toBe(true);
    }
  });

  it('grows every pool when the database grows', () => {
    const small = poolPlan(PROD).perService;
    const large = poolPlan({ ...PROD, serverMaxConnections: 200 }).perService;
    for (const service of Object.keys(SERVICE_POOL_WEIGHTS)) {
      const key = service as keyof typeof SERVICE_POOL_WEIGHTS;
      expect(large[key]).toBeGreaterThanOrEqual(small[key]);
    }
    expect(large.server).toBeGreaterThan(small.server);
  });

  it('never hands a service a pool it cannot open a connection with', () => {
    // A tiny database drives every proportional share below one; flooring
    // there would leave a service unable to reach Postgres at all.
    const plan = poolPlan({ ...PROD, serverMaxConnections: 8 });
    for (const size of Object.values(plan.perService)) expect(size).toBeGreaterThanOrEqual(1);
  });

  it('gives the request path and the single writer the largest pools', () => {
    const { perService } = poolPlan({ ...PROD, serverMaxConnections: 100 });
    expect(perService.server).toBeGreaterThan(perService['executor-ui']);
    expect(perService.orchestrator).toBeGreaterThan(perService['executor-ui']);
  });
});

describe('poolMaxForService', () => {
  it('answers for a pooled service and declines for anything else', () => {
    expect(poolMaxForService('server', PROD)).toBe(poolPlan(PROD).perService.server);
    expect(poolMaxForService('web')).toBeUndefined();
  });
});

describe('serverMaxConnectionsFromEnv', () => {
  it('falls back to the tier default when unset, blank or unusable', () => {
    for (const raw of [undefined, '', '   ', 'not-a-number', '0', '-5']) {
      expect(serverMaxConnectionsFromEnv({ DB_SERVER_MAX_CONNECTIONS: raw })).toBe(
        DEFAULT_SERVER_MAX_CONNECTIONS,
      );
    }
  });

  it('takes the operator value when it is usable', () => {
    expect(serverMaxConnectionsFromEnv({ DB_SERVER_MAX_CONNECTIONS: '100' })).toBe(100);
  });
});

/**
 * The launcher decides how many processes share a host; this module decides
 * what each of them may hold. They describe the same fleet from two sides, so
 * a service added to one and not the other is a host running a pool nobody
 * budgeted for — silently, since the launcher simply passes no size and the
 * package default applies.
 */
describe('the launcher and the budget describe the same fleet', () => {
  const launcher = readFileSync(
    fileURLToPath(new URL('../../../../scripts/prod-launcher.mjs', import.meta.url)),
    'utf8',
  );

  /** The service list of one launcher profile, read out of its literal. */
  function launcherProfile(name: string): string[] {
    const key = /^[a-z]+$/.test(name) ? name : `'${name}'`;
    const start = launcher.indexOf(`\n  ${key}: [`);
    expect(start, `profile ${name} is missing from the launcher`).toBeGreaterThan(-1);
    const open = launcher.indexOf('[', start);
    const body = launcher.slice(open + 1, launcher.indexOf(']', open));
    return [...body.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
  }

  it.each(Object.keys(POOLED_FLEET))('profile %s matches', (profile) => {
    const budgeted = [...POOLED_FLEET[profile]!.services].sort();
    const spawned = launcherProfile(profile)
      .filter((s) => s in SERVICE_POOL_WEIGHTS)
      .sort();
    expect(spawned).toEqual(budgeted);
  });

  it('budgets every service the production profiles spawn', () => {
    const spawned = new Set(Object.keys(POOLED_FLEET).flatMap((p) => launcherProfile(p)));
    for (const service of spawned) {
      expect(
        SERVICE_POOL_WEIGHTS[service as keyof typeof SERVICE_POOL_WEIGHTS],
        `${service} runs in production but has no connection budget`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * The bug this guards: `PHOENIX_MAX_INSTANCES` is set on the autoscaling
 * service and on none of the worker VMs. When the plan read it from the
 * environment, the API host planned for two instances and every VM planned for
 * one — so the VMs handed their processes a larger share than the API host had
 * been told to leave them, each host reported that it fit, and the fleet was
 * over the database by the difference.
 */
describe('every host reaches the same plan', () => {
  it('does not depend on an environment only one host carries', () => {
    const reference = poolPlan();
    // Whatever a host's own environment says about its ceiling, the split it
    // computes for the fleet is identical.
    for (const profile of Object.keys(POOLED_FLEET)) {
      expect(poolPlan().perService, `${profile} disagrees`).toEqual(reference.perService);
    }
  });

  it('sums the real per-host allocation inside the budget', () => {
    const plan = poolPlan();
    let total = 0;
    for (const [profile, host] of Object.entries(POOLED_FLEET)) {
      for (const service of host.services) total += plan.perService[service] * host.instances;
    }
    expect(total).toBe(plan.fleetWorstCase);
    expect(total).toBeLessThanOrEqual(plan.budget);
  });
});

describe('instanceCeilingDrift', () => {
  it('stays quiet when the deploy config agrees, or says nothing', () => {
    expect(instanceCeilingDrift({ profile: 'web-core', configured: '2' })).toBeNull();
    expect(instanceCeilingDrift({ profile: 'worker', configured: undefined })).toBeNull();
    expect(instanceCeilingDrift({ profile: 'web-core', configured: 'junk' })).toBeNull();
  });

  it('reports a ceiling raised without the budget following', () => {
    const msg = instanceCeilingDrift({ profile: 'web-core', configured: '10' });
    expect(msg).toContain('plans for 2 web-core instance(s)');
    expect(msg).toContain('capped at 10');
  });
});

/**
 * The launcher sizes on the PROFILE, not on whether a profile's services
 * happen to be budgeted. `all` and `web-core-legacy` run the same services
 * production does, so matching on services alone handed a development
 * container the production fleet's shares of a database it does not point at.
 */
describe('the launcher gates pool sizing on the profile', () => {
  const launcher = readFileSync(
    fileURLToPath(new URL('../../../../scripts/prod-launcher.mjs', import.meta.url)),
    'utf8',
  );

  it('returns early for a profile the budget does not cover', () => {
    expect(launcher).toContain('if (!(profileName in POOLED_FLEET))');
  });

  it('covers only profiles that actually run in production', () => {
    const declared = [...launcher.matchAll(/^  '?([a-z-]+)'?: \[/gm)].map((m) => m[1]!);
    const dev = declared.filter((p) => !(p in POOLED_FLEET));
    // These exist for single-container dev and must stay out of the budget.
    expect(dev.sort()).toEqual(['all', 'web-core-legacy']);
  });
});
