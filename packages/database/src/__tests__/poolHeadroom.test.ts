/**
 * The arithmetic that was never done. `poolMax` lives in this package and the
 * instance ceiling lives in a deploy config, so nothing computed the product
 * until a migration job could not get a connection.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveOtherServiceConnections,
  fleetBasisNote,
  assessPoolHeadroom,
  poolHeadroomWarning,
  OPERATIONAL_CONNECTION_RESERVE,
  SUPERUSER_RESERVED_CONNECTIONS,
  serverCapacityDrift,
} from '../poolHeadroom.js';

/** What prod actually was on 2026-08-30: db-f1-micro, default max_connections. */
const F1_MICRO_MAX_CONNECTIONS = 25;

describe('assessPoolHeadroom', () => {
  it('fits at the ceiling that was in place before the incident', () => {
    const h = assessPoolHeadroom({
      poolMax: 5,
      instances: 2,
      maxConnections: F1_MICRO_MAX_CONNECTIONS,
      otherServices: 8,
    });
    expect(h.fits).toBe(true);
  });

  it('does not fit at the ceiling that broke the deploy', () => {
    // 10 x 5 = 50 against a budget of 11. The service that grew reported
    // nothing; the migration job took the failure.
    const h = assessPoolHeadroom({
      poolMax: 5,
      instances: 10,
      maxConnections: F1_MICRO_MAX_CONNECTIONS,
      otherServices: 8,
    });
    expect(h.fits).toBe(false);
    expect(h.worstCase).toBe(50);
  });

  it('reserves connections for work outside the serving path', () => {
    // The migration job runs at deploy time and fails the release when it
    // cannot connect, so its slots are not part of the fleet's budget.
    const h = assessPoolHeadroom({ poolMax: 1, instances: 1, maxConnections: 25 });
    expect(h.budget).toBe(25 - SUPERUSER_RESERVED_CONNECTIONS - OPERATIONAL_CONNECTION_RESERVE);
  });

  it('recommends a pool that fits the instance ceiling', () => {
    const h = assessPoolHeadroom({
      poolMax: 5,
      instances: 10,
      maxConnections: F1_MICRO_MAX_CONNECTIONS,
      otherServices: 8,
    });
    // A pool that small says the real answer is a bigger database, which is
    // what the recommendation is meant to make obvious.
    expect(h.recommendedPoolMax).toBe(1);
  });

  it('never recommends a pool of zero', () => {
    const h = assessPoolHeadroom({
      poolMax: 5,
      instances: 100,
      maxConnections: 25,
      otherServices: 8,
    });
    expect(h.recommendedPoolMax).toBeGreaterThanOrEqual(1);
  });

  it('fits once the database is sized for the fleet', () => {
    const h = assessPoolHeadroom({
      poolMax: 5,
      instances: 10,
      maxConnections: 100,
      otherServices: 8,
    });
    expect(h.fits).toBe(true);
  });
});

describe('poolHeadroomWarning', () => {
  it('states the arithmetic and every way out of it', () => {
    const opts = {
      poolMax: 5,
      instances: 10,
      maxConnections: F1_MICRO_MAX_CONNECTIONS,
      otherServices: 8,
    };
    const msg = poolHeadroomWarning(opts, assessPoolHeadroom(opts));

    expect(msg).toContain('10 instances x 5 connections = 50');
    expect(msg).toContain('DB_MAX_CONNECTIONS');
    expect(msg).toContain('instance ceiling');
    expect(msg).toContain('max_connections');
  });
});

describe('the fleet reservation is what makes the check useful', () => {
  it('calls an unsafe fleet safe when the other services are not counted', () => {
    // The diagnostic's whole job is catching the next unsafe scale-up. Omitting
    // what the worker VM and phoenix-ai hold is enough to make it miss one.
    const shared = { poolMax: 5, instances: 3, maxConnections: F1_MICRO_MAX_CONNECTIONS };

    expect(assessPoolHeadroom(shared).fits).toBe(true);
    expect(assessPoolHeadroom({ ...shared, otherServices: 8 }).fits).toBe(false);
  });
});

describe('what counts as the rest of the fleet', () => {
  it('takes a stated peak over a boot-time reading', () => {
    // The reading is this process at its quietest; the operator states worst
    // case, which is what a worst-case check needs.
    expect(resolveOtherServiceConnections({ configured: '10', measured: 4 })).toEqual({
      value: 10,
      basis: 'configured',
    });
  });

  it('falls back to the reading, and says that is what it did', () => {
    expect(resolveOtherServiceConnections({ measured: 4 })).toEqual({
      value: 4,
      basis: 'observed',
    });
  });

  it('assumes nothing when the fleet cannot be counted', () => {
    expect(resolveOtherServiceConnections({ measured: null })).toEqual({
      value: 0,
      basis: 'unknown',
    });
    expect(resolveOtherServiceConnections({})).toEqual({ value: 0, basis: 'unknown' });
  });

  it('falls through a junk or blank override to the reading', () => {
    for (const configured of ['', '  ', 'lots', '-3']) {
      expect(resolveOtherServiceConnections({ configured, measured: 4 })).toEqual({
        value: 4,
        basis: 'observed',
      });
    }
  });

  it('accepts a stated zero, which is a real answer', () => {
    expect(resolveOtherServiceConnections({ configured: '0', measured: 9 })).toEqual({
      value: 0,
      basis: 'configured',
    });
  });
});

describe('the warning says what it is standing on', () => {
  it('tells an operator on a live reading how to get a worst-case check', () => {
    // Silence from an optimistic check is the failure this note exists to
    // prevent someone reading as safety.
    expect(fleetBasisNote('observed')).toContain('DB_FLEET_RESERVED_CONNECTIONS');
    expect(fleetBasisNote('observed')).toMatch(/quiet/i);
  });

  it('says when nothing could be counted at all', () => {
    expect(fleetBasisNote('unknown')).toMatch(/whole database/i);
  });

  it('names the source when one was configured', () => {
    expect(fleetBasisNote('configured')).toContain('DB_FLEET_RESERVED_CONNECTIONS');
  });
});

describe('serverCapacityDrift', () => {
  it('stays quiet when the declaration matches the instance', () => {
    expect(serverCapacityDrift({ declared: 25, actual: 25 })).toBeNull();
  });

  it('reports a declaration larger than the database, which oversubscribes it', () => {
    const drift = serverCapacityDrift({ declared: 100, actual: 25 });
    expect(drift?.message).toContain('can exhaust the database');
    expect(drift?.message).toContain('DB_SERVER_MAX_CONNECTIONS=25');
  });

  it('reports a declaration smaller than the database, which caps it for nothing', () => {
    const drift = serverCapacityDrift({ declared: 25, actual: 200 });
    expect(drift?.message).toContain('capped below what it could use');
    expect(drift?.message).toContain('DB_SERVER_MAX_CONNECTIONS=200');
  });
});
