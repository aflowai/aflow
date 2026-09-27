/**
 * The allocation only means something if it reaches the pool.
 *
 * `getDatabaseConfig` read `DB_MAX_CONNECTIONS` and `createDatabase` defaulted
 * to a literal of its own, so a caller passing only a connection string — four
 * executors do — opened twenty connections whatever the fleet had allocated
 * it. The launcher set the variable, the process ignored it, and nothing
 * anywhere reported the difference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { resolvePoolMax } from '../connection.js';
import { poolPlan } from '../connectionBudget.js';

describe('resolvePoolMax', () => {
  it('takes the allocated size', () => {
    expect(resolvePoolMax({ DB_MAX_CONNECTIONS: '3' } as NodeJS.ProcessEnv)).toBe(3);
  });

  it('ignores a value that is not a usable count', () => {
    for (const raw of ['', '   ', 'junk', '0', '-4']) {
      expect(
        resolvePoolMax({ DB_MAX_CONNECTIONS: raw, NODE_ENV: 'production' } as NodeJS.ProcessEnv),
      ).toBe(1);
    }
  });

  it('falls back to one in production, which the declared plan can absorb', () => {
    expect(resolvePoolMax({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(1);
    expect(resolvePoolMax({} as NodeJS.ProcessEnv)).toBe(20);
  });

  it('leaves the reserve intact when an unbudgeted process appears', () => {
    // The fleet already holds 17 of 19 servable. A stray process taking the
    // old fallback of five would reach past the budget and into the reserve
    // the migration job runs on, which is the exhaustion being prevented.
    const plan = poolPlan();
    const stray = resolvePoolMax({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(plan.fleetWorstCase + stray).toBeLessThanOrEqual(plan.budget);
  });
});

/**
 * Both constructors must resolve the size the same way. A literal in either
 * one is how they came apart the first time, so the guard is on the source:
 * no pool may be built from a hard-coded maximum.
 */
describe('the two constructors cannot drift', () => {
  const source = readFileSync(
    join(fileURLToPath(new URL('../', import.meta.url)), 'connection.ts'),
    'utf8',
  );

  it('builds no pool from a literal maximum', () => {
    const literals = [...source.matchAll(/max:\s*(\d+)/g)].map((m) => m[0]);
    expect(literals, `postgres() called with a hard-coded max: ${literals.join(', ')}`).toEqual([]);
  });

  it('defaults every construction path through resolvePoolMax', () => {
    const defaults = [...source.matchAll(/maxConnections \?\? ([A-Za-z0-9_()]+)/g)].map(
      (m) => m[1],
    );
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) expect(d).toBe('resolvePoolMax()');
  });
});

/**
 * One pool per process is what the budget counts. A second construction inside
 * a service that already has one doubles its real draw while every report
 * still shows the allocated figure.
 */
describe('the server holds one pool', () => {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));

  it('builds no private pool in the app context', () => {
    const context = readFileSync(
      join(repo, 'packages/server-runtime/src/services/context.ts'),
      'utf8',
    );
    expect(context).not.toContain('createDatabase(');
    expect(context).toContain('getConnection()');
  });
});
