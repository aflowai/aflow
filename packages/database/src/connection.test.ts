/**
 * An explicit `DB_SSL` decides, because the inferred production default is
 * wrong for a database reachable only from its own private network — and
 * without a way to say so, such a deployment cannot connect at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabaseConfig } from './connection.js';

const MANAGED = ['DATABASE_URL', 'NODE_ENV', 'DB_SSL'] as const;

describe('getDatabaseConfig ssl', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MANAGED) saved.set(key, process.env[key]);
    process.env['DATABASE_URL'] = 'postgres://user:pass@db:5432/app';
    delete process.env['NODE_ENV'];
    delete process.env['DB_SSL'];
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('infers TLS in production', () => {
    process.env['NODE_ENV'] = 'production';
    expect(getDatabaseConfig().ssl).toBe('require');
  });

  it('infers TLS from the connection string', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@db:5432/app?sslmode=require';
    expect(getDatabaseConfig().ssl).toBe('require');
  });

  it('leaves TLS off in development', () => {
    expect(getDatabaseConfig().ssl).toBeUndefined();
  });

  it('turns TLS on when asked, outside production', () => {
    process.env['DB_SSL'] = 'true';
    expect(getDatabaseConfig().ssl).toBe('require');
  });

  // The case the appliance needs: a production build, a private network, and
  // nothing in front of Postgres to terminate TLS.
  //
  // `false`, not absent. postgres.js maps `sslmode` out of the connection
  // string into its own `ssl` option, so omitting ours would let the URL
  // reinstate what was turned off — and asserting `undefined` here would be
  // asserting that bug.
  it('turns TLS off when asked, inside production', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DB_SSL'] = 'false';
    expect(getDatabaseConfig().ssl).toBe(false);
  });

  it('turns TLS off when asked, over a connection string that hints at it', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@db:5432/app?sslmode=require';
    process.env['DB_SSL'] = 'false';
    expect(getDatabaseConfig().ssl).toBe(false);
  });

  // Absent, not `false`: nothing should be passed where nothing was asked for.
  it('says nothing about TLS when nothing asked', () => {
    expect(getDatabaseConfig().ssl).toBeUndefined();
  });
});
