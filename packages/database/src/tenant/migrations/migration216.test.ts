/**
 * Read from the SQL the migration actually sends, so the assertion is about
 * what reaches a tenant rather than a restatement of it.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getOperation } from '@aflow/schemas';

import { applyMigration216 } from './migration216.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration216(client, 't_00000000000000000000000000000216');
  return sent.join('\n');
}

describe('migration 216', () => {
  it('grants the capability host.commit.check is registered under', async () => {
    const check = getOperation('host.commit.check');
    expect(check).toBeDefined();
    const grant = JSON.stringify({
      capabilityGroupId: check?.capabilityGroupId,
      accessMode: check?.accessMode,
    });
    expect(grant).toBe('{"capabilityGroupId":"host.commit","accessMode":"write"}');
    expect(await sentSql()).toContain(`'[${grant}]'::jsonb`);
  });

  it('grants it to the profiles that run commands, and not to Read Only', async () => {
    const sql = await sentSql();
    expect(sql).toContain("name IN ('Full Access', 'Standard', 'Personal Safe')");
    expect(sql).not.toContain('Read Only');
  });

  it('appends only to system profiles, only once, and records its own version', async () => {
    const sql = await sentSql();
    const updates = sql.split(/;\s*/).filter((s) => s.includes('UPDATE'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('is_system_profile = true');
    expect(updates[0]).toMatch(/AND NOT \(allowed_capabilities @> /);
    expect(sql).toMatch(/VALUES \(216,/);
  });
});
