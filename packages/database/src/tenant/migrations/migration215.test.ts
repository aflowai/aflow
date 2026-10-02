/**
 * Read from the SQL the migration actually sends, so the assertion is about
 * what reaches a tenant rather than a restatement of it. The registry test
 * beside this one already holds every migration to recording its own version.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { BROWSER_PAGE_OPEN_OPERATION_ID, getOperation } from '@aflow/schemas';

import { applyMigration215 } from './migration215.js';

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
  await applyMigration215(client, 't_00000000000000000000000000000215');
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

describe('migration 215', () => {
  it('grants Full Access and Standard read and write, and Read Only read', async () => {
    const byProfile = grantsByProfile(await sentSql());
    const modes = (name: string): string[] =>
      (byProfile.get(name) ?? []).map((g) => `${g.capabilityGroupId}:${g.accessMode}`).sort();
    expect([...byProfile.keys()].sort()).toEqual(['Full Access', 'Read Only', 'Standard']);
    expect(modes('Full Access')).toEqual(['browser.page:read', 'browser.page:write']);
    expect(modes('Standard')).toEqual(['browser.page:read', 'browser.page:write']);
    expect(modes('Read Only')).toEqual(['browser.page:read']);
  });

  it('names the capability group the browser operations are registered under', async () => {
    const group = getOperation(BROWSER_PAGE_OPEN_OPERATION_ID)?.capabilityGroupId;
    expect(group).toBe('browser.page');
    expect(await sentSql()).toContain(`"capabilityGroupId":"${String(group)}"`);
  });

  it('appends only to system profiles and only once', async () => {
    const sql = await sentSql();
    const updates = sql.split(/;\s*/).filter((s) => s.includes('UPDATE'));
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update).toContain('is_system_profile = true');
      expect(update).toMatch(/AND NOT \(allowed_capabilities @> /);
    }
  });
});
