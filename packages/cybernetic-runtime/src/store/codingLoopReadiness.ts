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
  preview?: boolean;
  failure?: string;
}

export function codingLoopReadiness(state: CodingLoopSetupState): {
  status: 'ready' | 'needs_setup' | 'broken';
  tasks: PostInstallTask[];
} {
  const tasks: PostInstallTask[] = [];
  const add = (
    step: 'machine' | 'folder' | 'github' | 'schedule' | 'preview',
    description: string,
    path: string,
  ): void => {
    tasks.push({ kind: 'coding_loop_setup', step, description, path, required: true });
  };
  if (!state.machine)
    add(
      'machine',
      'Pair the machine under This Computer and keep its coding agent signed in.',
      '/this-computer',
    );
  if (!state.folder)
    add(
      'folder',
      'Connect a repository folder under This Computer allowing commands and pushes with a branch prefix. Choose its merge posture on the machine: aflow harness merge-posture <folder> <never|when-green>. Then install Coding Loop again to create the shepherd agent.',
      '/this-computer',
    );
  if (!state.github)
    add(
      'github',
      'Bind a GitHub credential to the github connector in Integrations. Fine-grained permissions: Metadata and Contents read, Checks and Actions read, Pull requests and Issues write, plus Contents write for merges. Classic tokens need repo (public_repo for public repositories).',
      '/integrations',
    );
  if (!state.schedule)
    add(
      'schedule',
      'Create an active repeating schedule for the Local PR Shepherd agent (normally */5 * * * *), with inputTemplate { "scheduleId": { "$schedule": "id" } } so each pass can renew it before its firing cap.',
      '/triggers',
    );
  // Undefined until Plan 320 P6 supplies the folder preview declaration.
  if (state.preview === false)
    add(
      'preview',
      'Declare the connected folder’s preview command and URL on the machine under This Computer.',
      '/this-computer',
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
    failure: string | null;
  }>(sql`
    SELECT
      ARRAY(SELECT host_binding_id FROM host_bindings WHERE space_id = ${spaceId}::uuid
        AND allows_execution AND branch_prefix IS NOT NULL AND branch_prefix <> '') AS folder_ids,
      EXISTS (SELECT 1 FROM api_bindings b JOIN api_credentials c
        ON c.space_id = b.space_id AND c.credential_key = b.auth_json->>'credentialKey'
        WHERE b.space_id = ${spaceId}::uuid AND b.api_id = 'github') AS github,
      EXISTS (SELECT 1 FROM agent_schedules s JOIN agents a ON a.id = s.target_agent_id
        AND a.space_id = s.space_id WHERE s.space_id = ${spaceId}::uuid
        AND a.slug = 'local-pr-shepherd' AND s.status = 'active' AND s.kind = 'cron'
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND (s.max_firings IS NULL OR s.firing_count < s.max_firings)
        AND s.input_template->'scheduleId' = '{"$schedule":"id"}'::jsonb) AS schedule,
      (SELECT s.last_error FROM agent_schedules s JOIN agents a ON a.id = s.target_agent_id
        AND a.space_id = s.space_id WHERE s.space_id = ${spaceId}::uuid
        AND a.slug = 'local-pr-shepherd' AND s.status = 'active' AND s.last_error IS NOT NULL
        ORDER BY s.updated_at DESC LIMIT 1) AS failure
  `);
  return codingLoopReadiness({
    machine: inventories.length > 0,
    folder: inventories.some((inventory) =>
      inventory.folders.some(
        (folder) => folder.spaceId === spaceId && (state?.folder_ids ?? []).includes(folder.id),
      ),
    ),
    github: state?.github ?? false,
    schedule: state?.schedule ?? false,
    ...(state?.failure ? { failure: state.failure } : {}),
  });
}
