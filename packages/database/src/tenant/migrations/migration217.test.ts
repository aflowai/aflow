/**
 * Read from the SQL the migration actually sends, so the assertion is about
 * what reaches a tenant rather than a restatement of it. The registry test
 * beside this one already holds every migration to recording its own version.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { BROWSER_PAGE_OPEN_OPERATION_ID, getAllOperations, getOperation } from '@aflow/schemas';

import { applyMigration217 } from './migration217.js';

interface Grant {
  capabilityGroupId: string;
  accessMode: string;
}

async function sentSql(): Promise<string> {
  const sent: string[] = [];
  const client = {
    unsafe: (text: string) => {
      sent.push(text);
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  await applyMigration217(client, 't_00000000000000000000000000000217');
  return sent.join('\n');
}

/** Each UPDATE's appended grants, keyed by the profile names it selects. */
function grantsByProfile(sql: string): Map<string, Grant[]> {
  const byProfile = new Map<string, Grant[]>();
  for (const statement of sql.split(/;\s*/).filter((s) => s.includes('UPDATE'))) {
    const appended = /\|\|\s*'(\[[\s\S]*?\])'::jsonb/.exec(statement)?.[1];
    const names =
      /name IN \(([^)]+)\)/.exec(statement)?.[1] ?? /name = ('[^']+')/.exec(statement)?.[1];
    expect(appended, 'an UPDATE appends no grant').toBeDefined();
    expect(names, 'an UPDATE selects no profile by name').toBeDefined();
    const grants = JSON.parse(appended ?? '[]') as Grant[];
    for (const match of (names ?? '').matchAll(/'([^']+)'/g)) {
      byProfile.set(match[1] as string, grants);
    }
  }
  return byProfile;
}

const BROWSER_GRANTS = [
  'browser.page:read',
  'browser.page:write',
  'browser.profile:read',
  'browser.profile:write',
];

describe('migration 217', () => {
  it('grants Personal Safe read and write, and no other profile anything', async () => {
    const byProfile = grantsByProfile(await sentSql());
    expect([...byProfile.keys()]).toEqual(['Personal Safe']);
    expect(
      (byProfile.get('Personal Safe') ?? [])
        .map((g) => `${g.capabilityGroupId}:${g.accessMode}`)
        .sort(),
    ).toEqual(BROWSER_GRANTS);
  });

  it('covers every capability group and access mode the browser operations are registered under', async () => {
    const needed = new Set(
      [...getAllOperations().values()]
        .filter((op) => op.stepType === 'browser')
        .map((op) => `${op.capabilityGroupId}:${op.accessMode}`),
    );
    expect(
      needed.has(
        `${String(getOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.capabilityGroupId)}:write`,
      ),
    ).toBe(true);
    const granted = new Set(
      (grantsByProfile(await sentSql()).get('Personal Safe') ?? []).map(
        (g) => `${g.capabilityGroupId}:${g.accessMode}`,
      ),
    );
    for (const grant of needed) expect(granted, grant).toContain(grant);
  });

  it('appends only to the system profile and only once', async () => {
    const sql = await sentSql();
    const updates = sql.split(/;\s*/).filter((s) => s.includes('UPDATE'));
    expect(updates).toHaveLength(1);
    for (const update of updates) {
      expect(update).toContain('is_system_profile = true');
      expect(update).toMatch(/AND NOT \(allowed_capabilities @> /);
    }
  });
});
