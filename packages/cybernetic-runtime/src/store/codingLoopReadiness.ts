import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PostInstallTask } from '@aflow/schemas';
import type { Redis } from 'ioredis';
import { readLiveHostInventories } from '@aflow/redis';

export interface CodingLoopSetupState {
  machine: boolean;
  folder: boolean;
  github: boolean;
  schedule: boolean;
  agent: boolean;
  archivedAgent?: boolean;
  preview?: boolean;
  failure?: string;
}

export function codingLoopReadiness(state: CodingLoopSetupState): {
  status: 'ready' | 'needs_setup' | 'broken';
  tasks: PostInstallTask[];
} {
  const tasks: PostInstallTask[] = [];
  const add = (
    step: Extract<PostInstallTask, { kind: 'coding_loop_setup' }>['step'],
    description: string,
    path: string,
  ): void => {
    tasks.push({ kind: 'coding_loop_setup', step, description, path, required: true });
  };
  if (!state.machine)
    add(
      'machine',
      'Pair the machine under This Computer and keep its coding agent signed in.',
      '/computer',
    );
  if (!state.folder)
    add(
      'folder',
      'Connect a repository folder under This Computer allowing commands and pushes with a branch prefix. Choose its merge posture on the machine: aflow harness merge-posture <folder> <never|when-green>.',
      '/computer',
    );
  if (!state.agent)
    add(
      'agent',
      state.archivedAgent
        ? 'Restore the archived Local PR Shepherd agent before enabling its repeating schedule.'
        : 'After connecting a publishing folder, install Coding Loop or choose Repair installation on its Store listing if already installed to create the missing Local PR Shepherd agent.',
      state.archivedAgent ? '/agents' : '/store/coding-loop',
    );
  if (!state.github)
    add(
      'github',
      'Enable the github connection in Integrations and bind a GitHub credential to it. Fine-grained permissions: Metadata and Contents read, Checks and Actions read, Pull requests and Issues write, plus Contents write for merges. Classic tokens need repo (public_repo for public repositories).',
      '/integrations',
    );
  if (!state.schedule)
    add(
      'schedule',
      'Create an active repeating schedule for the Local PR Shepherd agent (normally */5 * * * *), with inputTemplate { "input": "tend", "config": { "scheduleId": { "$schedule": "id" } } } so each pass can renew it before its firing cap.',
      '/triggers',
    );
  // Undefined until Plan 320 P6 supplies the folder preview declaration.
  if (state.preview === false)
    add(
      'preview',
      'Declare the connected folder’s preview command and URL on the machine under This Computer.',
      '/computer',
    );
  return { status: state.failure ? 'broken' : tasks.length > 0 ? 'needs_setup' : 'ready', tasks };
}

export async function readCodingLoopReadiness(
  tx: PostgresJsDatabase,
  spaceId: string,
  redis?: Redis | null,
): Promise<ReturnType<typeof codingLoopReadiness>> {
  const inventories = redis ? await readLiveHostInventories(redis) : [];
  const [state] = await tx.execute<{
    folder_ids: string[];
    github: boolean;
    schedule: boolean;
    agent: boolean;
    archived_agent: boolean;
    failure: string | null;
  }>(sql`
    SELECT
      ARRAY(SELECT host_binding_id FROM host_bindings WHERE space_id = ${spaceId}::uuid
        AND allows_execution AND branch_prefix IS NOT NULL AND branch_prefix <> '') AS folder_ids,
      EXISTS (SELECT 1 FROM agents WHERE space_id = ${spaceId}::uuid
        AND slug = 'local-pr-shepherd' AND archived_at IS NULL) AS agent,
      EXISTS (SELECT 1 FROM agents WHERE space_id = ${spaceId}::uuid
        AND slug = 'local-pr-shepherd' AND archived_at IS NOT NULL) AS archived_agent,
      EXISTS (SELECT 1 FROM api_bindings b JOIN api_credentials c
        ON c.space_id = b.space_id AND c.credential_key = b.auth_json->>'credentialKey'
        WHERE b.space_id = ${spaceId}::uuid AND b.api_id = 'github' AND b.enabled = 1) AS github,
      EXISTS (SELECT 1 FROM agent_schedules s JOIN agents a ON a.id = s.target_agent_id
        AND a.space_id = s.space_id WHERE s.space_id = ${spaceId}::uuid
        AND a.archived_at IS NULL AND a.slug = 'local-pr-shepherd' AND s.status = 'active' AND s.kind = 'cron'
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND (s.max_firings IS NULL OR s.firing_count < s.max_firings)
        AND s.input_template -> 'config' -> 'scheduleId' = '{"$schedule":"id"}'::jsonb) AS schedule,
      (SELECT COALESCE(s.last_error, 'The latest shepherd execution failed.')
        FROM agent_schedules s JOIN agents a ON a.id = s.target_agent_id
        AND a.space_id = s.space_id
        LEFT JOIN sessions execution ON execution.session_id = s.last_session_id
          AND execution.space_id = s.space_id
        WHERE s.space_id = ${spaceId}::uuid
        AND a.archived_at IS NULL AND a.slug = 'local-pr-shepherd' AND s.status = 'active'
        AND (s.last_error IS NOT NULL OR execution.status = 'FAILED'
          OR EXISTS (SELECT 1 FROM workflow_runs run
            WHERE run.session_id = s.last_session_id AND run.space_id = s.space_id
              AND run.status = 'failed'))
        ORDER BY s.updated_at DESC LIMIT 1) AS failure
  `);
  return codingLoopReadiness({
    machine: inventories.length > 0,
    folder: inventories.some((inventory) =>
      inventory.folders.some(
        (folder) => folder.spaceId === spaceId && (state?.folder_ids ?? []).includes(folder.id),
      ),
    ),
    agent: state?.agent ?? false,
    archivedAgent: state?.archived_agent ?? false,
    github: state?.github ?? false,
    schedule: state?.schedule ?? false,
    ...(state?.failure ? { failure: state.failure } : {}),
  });
}
