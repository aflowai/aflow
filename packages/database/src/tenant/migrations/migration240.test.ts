/**
 * Read from the SQL the migration sends, so the assertion is about what reaches
 * a tenant rather than a restatement of it.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { SPACE_AUTONOMY_UPDATE_OPERATION_ID, getAllOperations, getOperation } from '@aflow/schemas';

import { applyMigration240 } from './migration240.js';

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration240(client, 't_00000000000000000000000000000240');
  return sent.join('\n');
}

describe('migration 240', () => {
  it('grants Full Access and Standard the space.autonomy write, and Read Only nothing', async () => {
    const sql = await sentSql();
    const appended = /\|\|\s*'(\[[\s\S]*?\])'::jsonb/.exec(sql)?.[1] ?? '[]';
    expect(JSON.parse(appended)).toEqual([
      { capabilityGroupId: 'space.autonomy', accessMode: 'write' },
    ]);
    expect(sql).toContain("name IN ('Full Access', 'Standard')");
    expect(sql).not.toContain('Read Only');
  });

  it('covers every access mode the space.autonomy operations are registered under', () => {
    expect(getOperation(SPACE_AUTONOMY_UPDATE_OPERATION_ID)?.capabilityGroupId).toBe(
      'space.autonomy',
    );
    const modes = [...getAllOperations().values()]
      .filter((op) => op.capabilityGroupId === 'space.autonomy')
      .map((op) => op.accessMode);
    expect([...new Set(modes)]).toEqual(['write']);
  });
});
