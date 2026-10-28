/**
 * The readiness facts query against Postgres: the tables it reads, shadowed by
 * temporary ones holding just the columns it names.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@aflow/database';
import type { Redis } from 'ioredis';
import {
  CODING_LOOP_READINGS,
  readReadinessFacts,
  readinessTasks,
  githubCredentialFingerprint,
} from './readinessReaders.js';

vi.mock('@aflow/redis', () => ({
  readLiveHostInventories: vi.fn(async () => [
    {
      hostname: 'studio',
      harnesses: [{ id: 'codex', installed: true }],
      folders: [
        {
          id: 'folder',
          spaceId: '00000000-0000-4000-8000-000000000001',
          pushApproval: 'unless-unreviewed',
          mergePosture: 'never',
          sandbox: 'open',
        },
      ],
    },
  ]),
}));

const databaseUrl = process.env['DATABASE_URL'];
const space = '00000000-0000-4000-8000-000000000001';
const agent = '00000000-0000-4000-8000-0000000000a1';
/** The template the shepherd's schedule renews from: its own id under the agent's config. */
const RENEWAL_TEMPLATE = '{"input":"tend","config":{"scheduleId":{"$schedule":"id"}}}';
/** GitHub's answer for the sealed credential below, asked before the transaction. */
const githubAnswers = new Map([
  [githubCredentialFingerprint('sealed'), { kind: 'accepted' as const, scopes: ['repo'] }],
]);
const ALL = new Set(CODING_LOOP_READINGS);

describe.skipIf(!databaseUrl)('readiness facts in the database', () => {
  const handle = createDatabase({ connectionString: databaseUrl ?? '' });
  afterAll(async () => handle.close());

  it('reads every item from live state, and counts a schedule renewing from config', async () => {
    await handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE spaces (id uuid, preferred_harness text) ON COMMIT DROP`,
      );
      await tx.execute(sql`CREATE TEMP TABLE host_bindings
        (host_binding_id text, space_id uuid, label text, allows_execution boolean,
         branch_prefix text, created_at timestamptz) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE api_bindings
        (space_id uuid, api_id text, auth_json jsonb, enabled integer) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE api_credentials
        (space_id uuid, credential_key text, encrypted_value text) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE agents
        (id uuid, space_id uuid, slug text, archived_at timestamptz, updated_at timestamptz)
        ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE agent_versions
        (agent_id uuid, created_at timestamptz) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE agent_schedules
        (target_agent_id uuid, space_id uuid, status text, kind text, cron_expression text,
         expires_at timestamptz, max_firings integer, firing_count integer, input_template jsonb,
         last_error text, last_session_id uuid, created_at timestamptz) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE sessions
        (session_id uuid, space_id uuid, status text) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE workflow_runs
        (session_id uuid, space_id uuid, status text) ON COMMIT DROP`);

      const read = async () =>
        readinessTasks(
          await readReadinessFacts(tx, space, ALL, {
            redis: {} as Redis,
            hostLane: 'present',
            githubAnswers,
          }),
          ALL,
        );
      const states = async () => (await read()).map((task) => ('state' in task ? task.state : ''));

      expect(await states()).toEqual([
        'done',
        'needs_setup',
        'needs_setup',
        'needs_setup',
        'needs_setup',
      ]);

      await tx.execute(sql`INSERT INTO spaces VALUES (${space}::uuid, 'codex')`);
      await tx.execute(sql`INSERT INTO host_bindings VALUES
        ('folder', ${space}::uuid, 'app', true, 'aflow/', now() - interval '2 days')`);
      await tx.execute(sql`INSERT INTO agents VALUES
        (${agent}::uuid, ${space}::uuid, 'local-pr-shepherd', NULL, now())`);
      await tx.execute(
        sql`INSERT INTO agent_versions VALUES (${agent}::uuid, now() - interval '1 day')`,
      );
      await tx.execute(sql`INSERT INTO api_bindings VALUES
        (${space}::uuid, 'github', '{"credentialKey":"github"}', 1)`);
      await tx.execute(
        sql`INSERT INTO api_credentials VALUES (${space}::uuid, 'github', 'sealed')`,
      );
      expect(await states()).toEqual(['done', 'done', 'done', 'done', 'needs_setup']);

      await tx.execute(sql`INSERT INTO agent_schedules VALUES
        (${agent}::uuid, ${space}::uuid, 'active', 'cron', '*/5 * * * *', NULL, 50, 1,
         ${RENEWAL_TEMPLATE}::jsonb, NULL, ${space}::uuid, now())`);
      await tx.execute(
        sql`INSERT INTO sessions VALUES (${space}::uuid, ${space}::uuid, 'RUNNING')`,
      );
      expect((await read())[4]).toMatchObject({ state: 'done', firingsLeft: 49 });

      for (const template of [
        '{"input":"tend"}',
        '{"input":"tend","config":{}}',
        '{"scheduleId":{"$schedule":"id"}}',
        '{"input":"tend","scheduleId":{"$schedule":"id"}}',
      ]) {
        await tx.execute(sql`UPDATE agent_schedules SET input_template = ${template}::jsonb`);
        // Live, so it counts and nothing offers a second one; it says it will not renew.
        const reading = (await read())[4];
        expect(reading).toMatchObject({
          state: 'done',
          description: expect.stringContaining('without renewing itself'),
        });
        expect(reading).not.toHaveProperty('schedule');
      }
      await tx.execute(sql`UPDATE agent_schedules SET input_template =
        '{"input":"shepherd","note":"x","config":{"scheduleId":{"$schedule":"id"}}}'::jsonb`);
      expect((await read())[4]).toMatchObject({ state: 'done' });
      await tx.execute(sql`UPDATE agent_schedules SET input_template =
        '{"input":"shepherd","config":{"scheduleId":{"$schedule":"id"},"sibling":"ignored","nested":{"enabled":true}}}'::jsonb`);
      expect((await read())[4]).toMatchObject({
        state: 'done',
        description: expect.stringContaining('renews itself'),
      });
      await tx.execute(sql`UPDATE agent_schedules SET input_template = ${RENEWAL_TEMPLATE}::jsonb`);

      await tx.execute(sql`UPDATE sessions SET status = 'FAILED'`);
      expect((await read())[4]).toMatchObject({ state: 'broken' });
      await tx.execute(sql`UPDATE sessions SET status = 'SUCCEEDED'`);
      await tx.execute(
        sql`INSERT INTO workflow_runs VALUES (${space}::uuid, ${space}::uuid, 'failed')`,
      );
      expect((await read())[4]).toMatchObject({ state: 'broken' });
      await tx.execute(sql`DELETE FROM workflow_runs`);
      await tx.execute(sql`UPDATE agent_schedules SET last_error = 'Dispatch refused'`);
      expect((await read())[4]).toMatchObject({
        state: 'broken',
        description: expect.stringContaining('Dispatch refused'),
      });
      await tx.execute(sql`UPDATE agent_schedules SET last_error = NULL`);

      await tx.execute(sql`UPDATE agent_schedules SET status = 'expired', firing_count = 50`);
      expect((await read())[4]).toMatchObject({
        state: 'broken',
        schedule: {
          agentId: agent,
          cronExpression: '*/5 * * * *',
          maxFirings: 50,
          inputTemplate: JSON.parse(RENEWAL_TEMPLATE) as unknown,
        },
      });

      await tx.execute(sql`UPDATE api_bindings SET enabled = 0`);
      expect((await read())[2]).toMatchObject({
        state: 'needs_setup',
        description: expect.stringContaining('Enable'),
      });
      await tx.execute(sql`UPDATE api_bindings SET enabled = 1`);

      // The shepherd was written before the folder: the folder reading says so.
      await tx.execute(sql`UPDATE host_bindings SET created_at = now()`);
      expect((await read())[1]).toMatchObject({ state: 'needs_setup', shepherdBeforeFolder: true });

      await tx.execute(sql`UPDATE agents SET archived_at = now()`);
      expect((await read())[4]).toMatchObject({ state: 'needs_setup', page: '/agents' });
    });
  });
});
