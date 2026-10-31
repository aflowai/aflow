/**
 * Read from the SQL the migration sends, so the assertion is about what reaches
 * a tenant rather than a restatement of it.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { CHANNEL_MESSAGE_SEND_OPERATION_ID, getAllOperations, getOperation } from '@aflow/schemas';

import { applyMigration235 } from './migration235.js';

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
  await applyMigration235(client, 't_00000000000000000000000000000235');
  return sent.join('\n');
}

/** Each UPDATE's appended grants, keyed by the profile names it selects. */
function grantsByProfile(sql: string): Map<string, string[]> {
  const byProfile = new Map<string, string[]>();
  for (const statement of sql.split(/;\s*/).filter((s) => s.includes('UPDATE'))) {
    const appended = /\|\|\s*'(\[[\s\S]*?\])'::jsonb/.exec(statement)?.[1] ?? '[]';
    const names =
      /name IN \(([^)]+)\)/.exec(statement)?.[1] ?? /name = ('[^']+')/.exec(statement)?.[1] ?? '';
    const grants = (JSON.parse(appended) as Grant[])
      .map((g) => `${g.capabilityGroupId}:${g.accessMode}`)
      .sort();
    for (const match of names.matchAll(/'([^']+)'/g)) byProfile.set(match[1] as string, grants);
  }
  return byProfile;
}

describe('migration 235', () => {
  it('grants Full Access and Standard read and write, and Read Only read', async () => {
    const byProfile = grantsByProfile(await sentSql());
    expect([...byProfile.keys()].sort()).toEqual(['Full Access', 'Read Only', 'Standard']);
    expect(byProfile.get('Full Access')).toEqual(['channel.message:read', 'channel.message:write']);
    expect(byProfile.get('Standard')).toEqual(['channel.message:read', 'channel.message:write']);
    expect(byProfile.get('Read Only')).toEqual(['channel.message:read']);
  });

  it('covers every capability group and access mode the channel operations are registered under', async () => {
    const needed = [...getAllOperations().values()]
      .filter((op) => op.stepType === 'channel')
      .map((op) => `${op.capabilityGroupId}:${op.accessMode}`);
    expect(getOperation(CHANNEL_MESSAGE_SEND_OPERATION_ID)?.capabilityGroupId).toBe(
      'channel.message',
    );
    const granted = grantsByProfile(await sentSql()).get('Standard') ?? [];
    for (const grant of needed) expect(granted, grant).toContain(grant);
  });

  it('appends only to system profiles and only once', async () => {
    const updates = (await sentSql()).split(/;\s*/).filter((s) => s.includes('UPDATE'));
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update).toContain('is_system_profile = true');
      expect(update).toMatch(/AND NOT \(allowed_capabilities @> /);
    }
  });
});
