/**
 * The local edition's default OAuth app, for a tenant bootstrap creates and for
 * one that already exists. The database suite proves the rows on Postgres; this
 * one runs everywhere and pins the statements bootstrap sends.
 */
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { EditionDescriptor, TenantId } from '@aflow/schemas';
import { bootstrapLocalEdition, ensureOAuthDefaultClientScope } from './localEdition.js';

const TENANT_ID = '00000000-0000-4000-8000-0000000ed247' as TenantId;

const EDITION: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: TENANT_ID },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
  browserLane: 'absent',
};

interface SentStatement {
  text: string;
  values: unknown[];
}

/** A tagged-template stand-in for postgres.js that answers each statement in turn. */
function recordingSql(answers: Array<unknown[]>): { sql: postgres.Sql; sent: SentStatement[] } {
  const sent: SentStatement[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sent.push({ text: strings.join('?'), values });
    return Promise.resolve(answers.shift() ?? []);
  };
  return { sql: tag as unknown as postgres.Sql, sent };
}

describe('the local default OAuth app', () => {
  it('creates a new local tenant on the tenant client', async () => {
    const { sql, sent } = recordingSql([[{ tenant_id: TENANT_ID }]]);
    // Bootstrap stops at the first statement this stand-in cannot answer; the
    // tenant row is written before that.
    await bootstrapLocalEdition({
      edition: EDITION,
      sql,
      db: {} as PostgresJsDatabase,
      ownerId: 'owner',
    }).catch(() => undefined);

    const insert = sent[0];
    expect(insert?.text).toContain('INSERT INTO public.tenants');
    expect(insert?.text).toContain('oauth_default_client_scope');
    expect(insert?.values).toContain('tenant');
  });

  it('moves an existing tenant holding the space client to the tenant client', async () => {
    const { sql, sent } = recordingSql([[{ tenant_id: TENANT_ID }]]);

    await expect(ensureOAuthDefaultClientScope(sql, EDITION, TENANT_ID)).resolves.toBe(true);

    const update = sent[0];
    expect(update?.text).toContain('UPDATE public.tenants');
    expect(update?.text).toContain('oauth_default_client_scope <>');
    expect(update?.values).toEqual(['tenant', TENANT_ID, 'tenant']);
  });

  it('reports an existing tenant already on the tenant client as unchanged', async () => {
    const { sql } = recordingSql([[]]);
    await expect(ensureOAuthDefaultClientScope(sql, EDITION, TENANT_ID)).resolves.toBe(false);
  });
});
