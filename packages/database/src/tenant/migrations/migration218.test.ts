/**
 * Read from the SQL the migration actually sends, so the assertion is about
 * what reaches a tenant rather than a restatement of it.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getOperationsByStepType } from '@aflow/schemas';

import { applyMigration218 } from './migration218.js';

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
  await applyMigration218(client, 't_00000000000000000000000000000218');
  return sent.join('\n');
}

function statements(sql: string): string[] {
  return sql.split(/;\s*/);
}

/** Each granting UPDATE's appended grants, keyed by the profile names it selects. */
function grantsByProfile(sql: string): Map<string, string[]> {
  const byProfile = new Map<string, string[]>();
  for (const statement of statements(sql).filter((s) => s.includes('UPDATE') && s.includes('||'))) {
    const appended = /\|\|\s*'(\[[\s\S]*?\])'::jsonb/.exec(statement)?.[1];
    const names =
      /name IN \(([^)]+)\)/.exec(statement)?.[1] ?? /name = ('[^']+')/.exec(statement)?.[1];
    expect(names, 'a granting UPDATE selects no profile by name').toBeDefined();
    expect(statement).toContain('is_system_profile = true');
    const grants = (JSON.parse(appended ?? '[]') as Grant[])
      .map((g) => `${g.capabilityGroupId}:${g.accessMode}`)
      .sort();
    for (const match of (names ?? '').matchAll(/'([^']+)'/g)) {
      byProfile.set(match[1] as string, grants);
    }
  }
  return byProfile;
}

const PLAN_OPERATIONS = [...getOperationsByStepType('plan').values()];

describe('migration 218', () => {
  it('creates plan_nodes with the plan’s columns and two indexes leading with space_id', async () => {
    const sql = await sentSql();
    const table = /CREATE TABLE IF NOT EXISTS "[^"]+"\.plan_nodes \(([\s\S]*?)\n\s*\);/.exec(
      sql,
    )?.[1];
    expect(table).toBeDefined();
    const columns = (table ?? '')
      .split('\n')
      .map((line) => /^\s*([a-z_]+)\s/.exec(line)?.[1])
      .filter((c): c is string => c !== undefined);
    expect(columns).toEqual([
      'id',
      'space_id',
      'parent_id',
      'kind',
      'title',
      'goal',
      'criteria',
      'status',
      'outcome',
      'note',
      'revision',
      'position',
      'created_by',
      'created_at',
      'updated_at',
      'closed_at',
    ]);
    const indexes = [
      ...sql.matchAll(/CREATE INDEX IF NOT EXISTS \w+\s+ON "[^"]+"\.plan_nodes \(([^)]+)\)/g),
    ].map((m) => m[1]);
    expect(indexes).toEqual(['space_id, status', 'space_id, parent_id']);
  });

  it('grants read and write to every authoring system profile, and read alone to Read Only', async () => {
    const byProfile = grantsByProfile(await sentSql());
    expect([...byProfile.keys()].sort()).toEqual(
      ['Full Access', 'Personal Safe', 'Read Only', 'Standard'].sort(),
    );
    for (const name of ['Full Access', 'Standard', 'Personal Safe']) {
      expect(byProfile.get(name), name).toEqual(['plan.node:read', 'plan.node:write']);
    }
    expect(byProfile.get('Read Only')).toEqual(['plan.node:read']);
  });

  it('covers every capability group and access mode the plan operations are registered under', async () => {
    expect(PLAN_OPERATIONS.length).toBeGreaterThan(0);
    const byProfile = grantsByProfile(await sentSql());
    for (const op of PLAN_OPERATIONS) {
      const grant = `${op.capabilityGroupId}:${op.accessMode}`;
      expect(byProfile.get('Full Access'), grant).toContain(grant);
      if (op.accessMode === 'read') expect(byProfile.get('Read Only'), grant).toContain(grant);
    }
  });

  it('appends each grant only once', async () => {
    for (const update of statements(await sentSql()).filter((s) => s.includes('||'))) {
      expect(update).toMatch(/AND NOT \(allowed_capabilities @> /);
    }
  });

  it('removes plan.read and plan.write from allowed and denied capabilities on every profile', async () => {
    const removal = statements(await sentSql()).find(
      (s) => s.includes('UPDATE') && !s.includes('||'),
    );
    expect(removal).toBeDefined();
    expect(removal).not.toContain('is_system_profile');
    for (const column of ['allowed_capabilities', 'denied_capabilities']) {
      expect(removal).toMatch(
        new RegExp(
          `${column} = COALESCE\\(\\([\\s\\S]*?NOT IN \\('plan\\.read', 'plan\\.write'\\)`,
        ),
      );
    }
  });
});
