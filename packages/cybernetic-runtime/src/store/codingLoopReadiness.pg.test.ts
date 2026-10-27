import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@aflow/database';
import type { Redis } from 'ioredis';
import { readCodingLoopReadiness } from './codingLoopReadiness.js';

vi.mock('@aflow/redis', () => ({
  readLiveHostInventories: vi.fn(async () => [
    { folders: [{ id: 'folder', spaceId: '00000000-0000-4000-8000-000000000001' }] },
  ]),
}));

const databaseUrl = process.env['DATABASE_URL'];
const space = '00000000-0000-4000-8000-000000000001';

describe.skipIf(!databaseUrl)('coding loop database readiness', () => {
  const handle = createDatabase({ connectionString: databaseUrl ?? '' });
  afterAll(async () => handle.close());

  it('reads execution outcomes after dispatch and requires an enabled credentialed binding', async () => {
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE host_bindings
        (host_binding_id text, space_id uuid, allows_execution boolean, branch_prefix text)
        ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE api_bindings
        (space_id uuid, api_id text, auth_json jsonb, enabled integer) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE api_credentials
        (space_id uuid, credential_key text) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE agents
        (id uuid, space_id uuid, slug text) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE agent_schedules
        (target_agent_id uuid, space_id uuid, status text, kind text, expires_at timestamptz,
         max_firings integer, firing_count integer, input_template jsonb, last_error text,
         last_session_id uuid, updated_at timestamptz) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE sessions
        (session_id uuid, space_id uuid, status text) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE workflow_runs
        (session_id uuid, space_id uuid, status text) ON COMMIT DROP`);
      await tx.execute(
        sql`INSERT INTO host_bindings VALUES ('folder', ${space}::uuid, true, 'aflow/')`,
      );
      await tx.execute(sql`INSERT INTO api_bindings VALUES
        (${space}::uuid, 'github', '{"credentialKey":"github"}', 1)`);
      await tx.execute(sql`INSERT INTO api_credentials VALUES (${space}::uuid, 'github')`);
      await tx.execute(
        sql`INSERT INTO agents VALUES (${space}::uuid, ${space}::uuid, 'local-pr-shepherd')`,
      );
      await tx.execute(sql`INSERT INTO agent_schedules VALUES
        (${space}::uuid, ${space}::uuid, 'active', 'cron', NULL, NULL, 1,
         '{"scheduleId":{"$schedule":"id"}}', NULL, ${space}::uuid, now())`);
      await tx.execute(
        sql`INSERT INTO sessions VALUES (${space}::uuid, ${space}::uuid, 'RUNNING')`,
      );
      const read = () => readCodingLoopReadiness(tx, space, {} as Redis);
      expect(await read()).toEqual({ status: 'ready', tasks: [] });

      await tx.execute(sql`UPDATE sessions SET status = 'FAILED'`);
      expect((await read()).status).toBe('broken');

      await tx.execute(sql`UPDATE sessions SET status = 'SUCCEEDED'`);
      await tx.execute(
        sql`INSERT INTO workflow_runs VALUES (${space}::uuid, ${space}::uuid, 'failed')`,
      );
      expect((await read()).status).toBe('broken');

      await tx.execute(sql`INSERT INTO sessions VALUES
        ('00000000-0000-4000-8000-000000000002', ${space}::uuid, 'SUCCEEDED')`);
      await tx.execute(sql`UPDATE agent_schedules SET
        last_session_id = '00000000-0000-4000-8000-000000000002', last_error = NULL`);
      expect(await read()).toEqual({ status: 'ready', tasks: [] });

      await tx.execute(sql`UPDATE agent_schedules SET last_error = 'Dispatch refused'`);
      expect((await read()).status).toBe('broken');
      await tx.execute(sql`UPDATE agent_schedules SET last_error = NULL`);
      await tx.execute(sql`UPDATE api_bindings SET enabled = 0`);
      expect(await read()).toMatchObject({
        status: 'needs_setup',
        tasks: [{ step: 'github', description: expect.stringContaining('Enable') }],
      });
      await tx.execute(sql`UPDATE api_bindings SET enabled = 1`);
      expect(await read()).toEqual({ status: 'ready', tasks: [] });
    });
  });
});
