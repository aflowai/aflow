/**
 * The readers behind the readiness kinds of the post-install manifest (Plan
 * 330 D4): each reads the live state an item stands on — the host inventory,
 * the space's host bindings, its github binding and GitHub's own answer for
 * that credential, its preferred harness, and the shepherd's schedules — and
 * says where the item stands, with the page or command that changes it.
 *
 * Only `generatePostInstallManifest` calls them, so the bundle install, the
 * Store page and the space's help surface read one function.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { createTenantContext, decryptCredentialAsync, withTenantSchema } from '@aflow/database';
import { readLiveHostInventories, type HostInventory } from '@aflow/redis';
import {
  CODING_HARNESS_OPTIONS,
  HOST_FOLDER_CONNECT_COMMAND,
  HOST_LANE_FOLDER_REFUSAL,
  HOST_LANE_HARNESS_REFUSAL,
  HOST_LANE_PAIRING_REFUSAL,
  MAX_FIRINGS_CAP,
  READINESS_EXTERNAL_TEXT_MAX,
  SHEPHERD_SCHEDULE_CRON_DEFAULT,
  SKILL_STARTER_SCHEDULE_VARIABLE,
  type HostMergePosture,
  type PostInstallTask,
  type ShepherdScheduleInput,
  type TenantId,
} from '@aflow/schemas';

/**
 * One stateful reading: a `pair_machine` reading, or one of the other readiness
 * kinds. The host lane's folder is read two ways: `folder` asks only that one
 * is connected, which is all a skill that reads and runs there needs, and
 * `publishing_folder` asks for the folder the coding loop publishes from — one
 * that pushes under a branch prefix, with a merge posture.
 */
export type ReadinessReading =
  | 'machine'
  | 'folder'
  | 'publishing_folder'
  | 'github_credential'
  | 'coding_harness'
  | 'shepherd_schedule';

/** The order the readings are listed in, which is the order the operator meets them. */
export const READINESS_READINGS: readonly ReadinessReading[] = [
  'machine',
  'folder',
  'publishing_folder',
  'github_credential',
  'coding_harness',
  'shepherd_schedule',
];

/** The coding loop's readings: Coding with GitHub's five items. */
export const CODING_LOOP_READINGS: readonly ReadinessReading[] = [
  'machine',
  'publishing_folder',
  'github_credential',
  'coding_harness',
  'shepherd_schedule',
];

const SHEPHERD_SLUG = 'local-pr-shepherd';

/** The input a shepherd schedule renews from: its own id under the agent's config. */
export const SHEPHERD_RENEWAL_INPUT: Record<string, unknown> = {
  input: 'tend',
  config: { [SKILL_STARTER_SCHEDULE_VARIABLE]: { $schedule: 'id' } },
};

const GITHUB_PERMISSIONS =
  'Fine-grained permissions: Metadata and Contents read, Checks and Actions read, Pull requests ' +
  'and Issues write, plus Contents write for merges. Classic tokens need repo (public_repo for ' +
  'public repositories).';

/**
 * An outside body as a description embeds it — a schedule's error, GitHub's
 * answer, a request or decryption failure — bounded at its own generous
 * ceiling, so the item reads broken with its reason however long the body is,
 * rather than the description outgrowing its cap and failing the response.
 */
function externalText(text: string): string {
  if (text.length <= READINESS_EXTERNAL_TEXT_MAX) return text;
  return `${text.slice(0, READINESS_EXTERNAL_TEXT_MAX)}… (${String(text.length - READINESS_EXTERNAL_TEXT_MAX)} more characters)`;
}

/** Classic token scopes, either of which lets publish and the shepherd reach a repository. */
const CLASSIC_REPOSITORY_SCOPES = ['repo', 'public_repo'];

// ============================================================================
// GitHub's answer for a credential
// ============================================================================

/**
 * What GitHub says when the credential is presented. `scopes` is the token's
 * `X-OAuth-Scopes` header, which GitHub sends for a classic token and an OAuth
 * app's token; `null` where it sends none — a fine-grained token and a GitHub
 * App installation token, whose permissions no endpoint lists.
 */
export type GithubCredentialAnswer =
  | { kind: 'accepted'; scopes: string[] | null }
  | { kind: 'refused'; status: number; message: string }
  | { kind: 'unreachable'; message: string };

export type GithubCredentialProbe = (token: string) => Promise<GithubCredentialAnswer>;

/** Answered for every kind of token, and spends none of the rate limit it reports. */
const GITHUB_PROBE_URL = 'https://api.github.com/rate_limit';
const GITHUB_PROBE_TIMEOUT_MS = 10_000;
const GITHUB_ANSWER_TTL_SECONDS = 300;
const GITHUB_UNREACHABLE_TTL_SECONDS = 60;

export const askGithubAboutCredential: GithubCredentialProbe = async (token) => {
  let response: Response;
  try {
    response = await fetch(GITHUB_PROBE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'aflow-readiness',
      },
      signal: AbortSignal.timeout(GITHUB_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'unreachable', message: err instanceof Error ? err.message : String(err) };
  }
  if (response.status === 401) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    return {
      kind: 'refused',
      status: response.status,
      message: typeof body?.message === 'string' ? body.message : 'Bad credentials',
    };
  }
  if (!response.ok) {
    return { kind: 'unreachable', message: `GitHub answered HTTP ${String(response.status)}` };
  }
  const header = response.headers.get('x-oauth-scopes');
  return {
    kind: 'accepted',
    scopes:
      header === null
        ? null
        : header
            .split(',')
            .map((scope) => scope.trim())
            .filter((scope) => scope.length > 0),
  };
};

/** GitHub's answers, by the fingerprint of the stored credential they were given for. */
export type GithubAnswers = ReadonlyMap<string, GithubCredentialAnswer>;

/**
 * A stored credential's fingerprint: a hash of its sealed value, which changes
 * whenever the credential does, so an answer is never read for another one.
 */
export function githubCredentialFingerprint(sealed: string): string {
  return createHash('sha256').update(sealed).digest('hex');
}

function githubAnswerKey(fingerprint: string): string {
  return `aflow:readiness:github-answer:${fingerprint}`;
}

/** What the readers find kept for a credential — read inside a transaction, never asked. */
async function keptGithubAnswer(
  fingerprint: string,
  redis: Redis | null | undefined,
): Promise<GithubCredentialAnswer | null> {
  if (!redis) return null;
  const kept = await redis.get(githubAnswerKey(fingerprint)).catch(() => null);
  return kept ? (JSON.parse(kept) as GithubCredentialAnswer) : null;
}

/**
 * GitHub's answer for one stored credential, asked only where nothing is kept
 * and then kept, a failure as well as an answer, so a refused or unreachable
 * credential is not asked about again on every read. An unreachable GitHub is
 * kept for less time than an answer.
 */
export async function askGithubOnce(
  sealed: string,
  opts: {
    redis?: Redis | null | undefined;
    probe?: GithubCredentialProbe | undefined;
    open?: (sealed: string) => Promise<string>;
  },
): Promise<GithubCredentialAnswer> {
  const fingerprint = githubCredentialFingerprint(sealed);
  const kept = await keptGithubAnswer(fingerprint, opts.redis);
  if (kept) return kept;
  let answer: GithubCredentialAnswer;
  try {
    const token = await (opts.open ?? decryptCredentialAsync)(sealed);
    answer = await (opts.probe ?? askGithubAboutCredential)(token);
  } catch (err) {
    answer = {
      kind: 'unreachable',
      message: `the stored credential could not be read (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (opts.redis) {
    const ttl =
      answer.kind === 'unreachable' ? GITHUB_UNREACHABLE_TTL_SECONDS : GITHUB_ANSWER_TTL_SECONDS;
    await opts.redis
      .set(githubAnswerKey(fingerprint), JSON.stringify(answer), 'EX', ttl)
      .catch(() => undefined);
  }
  return answer;
}

/**
 * Asks GitHub about the space's github credential before a readiness read,
 * outside any transaction: the credential is read in a short one of its own,
 * which has closed before the request leaves. The answers go to the readers
 * as `githubAnswers`.
 */
export async function askGithubForSpace(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  opts: { redis?: Redis | null | undefined; probe?: GithubCredentialProbe | undefined },
): Promise<GithubAnswers> {
  const sealed = await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    async (tx) => {
      const rows = await tx.execute<{ encrypted: string }>(sql`
      SELECT c.encrypted_value AS encrypted
        FROM api_bindings b JOIN api_credentials c
          ON c.space_id = b.space_id AND c.credential_key = b.auth_json->>'credentialKey'
        WHERE b.space_id = ${spaceId}::uuid AND b.api_id = 'github' AND b.enabled = 1
    `);
      return rows.map((row) => row.encrypted);
    },
  );
  const answers = new Map<string, GithubCredentialAnswer>();
  for (const value of new Set(sealed)) {
    answers.set(githubCredentialFingerprint(value), await askGithubOnce(value, opts));
  }
  return answers;
}

// ============================================================================
// The facts
// ============================================================================

export interface ReadinessFolder {
  id: string;
  label: string;
  allowsExecution: boolean;
  branchPrefix: string | null;
  connectedAt: string;
}

export interface ReadinessSchedule {
  status: string;
  cronExpression: string | null;
  maxFirings: number | null;
  firingCount: number;
  expiresAt: string | null;
  inputTemplate: Record<string, unknown>;
  /** Its input hands each pass its own id under config, so it renews itself (#204). */
  renews: boolean;
  /** A dispatch error, or its latest execution failed. */
  failure: string | null;
}

/** Everything the readings read, gathered once per manifest. */
export interface ReadinessFacts {
  spaceId: string;
  hostLane: 'present' | 'absent';
  now: number;
  inventories: ReadonlyArray<Pick<HostInventory, 'hostname' | 'harnesses' | 'folders'>>;
  folders: readonly ReadinessFolder[];
  preferredHarness: string | null;
  shepherd: { id: string; archived: boolean; writtenAt: string | null } | null;
  github: {
    enabled: boolean;
    credentialPresent: boolean;
    answer: GithubCredentialAnswer | null;
  } | null;
  /** The shepherd's cron schedules, newest first. */
  schedules: readonly ReadinessSchedule[];
}

export interface ReadinessReadOptions {
  redis?: Redis | null | undefined;
  hostLane: 'present' | 'absent';
  /**
   * GitHub's answers asked before the transaction (`askGithubForSpace`). The
   * readers never ask GitHub themselves: they run inside the caller's
   * transaction, and read only these and what Redis keeps.
   */
  githubAnswers?: GithubAnswers | undefined;
  now?: number;
}

/** `execute` reads rows indexable by column name. */
interface FactsRow extends Record<string, unknown> {
  preferred_harness: string | null;
  folders: ReadinessFolder[] | null;
  shepherd: ReadinessFacts['shepherd'];
  github: { enabled: boolean; encrypted: string | null } | null;
  schedules: ReadinessSchedule[] | null;
}

export async function readReadinessFacts(
  tx: PostgresJsDatabase,
  spaceId: string,
  readings: ReadonlySet<ReadinessReading>,
  opts: ReadinessReadOptions,
): Promise<ReadinessFacts> {
  const inventories = opts.redis ? await readLiveHostInventories(opts.redis) : [];
  const [row] = await tx.execute<FactsRow>(sql`
    SELECT
      (SELECT preferred_harness FROM spaces WHERE id = ${spaceId}::uuid) AS preferred_harness,
      (SELECT json_agg(json_build_object(
          'id', host_binding_id, 'label', label, 'allowsExecution', allows_execution,
          'branchPrefix', NULLIF(branch_prefix, ''), 'connectedAt', created_at
        ) ORDER BY created_at)
        FROM host_bindings WHERE space_id = ${spaceId}::uuid) AS folders,
      (SELECT json_build_object(
          'id', a.id, 'archived', a.archived_at IS NOT NULL,
          'writtenAt', (SELECT max(v.created_at) FROM agent_versions v WHERE v.agent_id = a.id))
        FROM agents a WHERE a.space_id = ${spaceId}::uuid AND a.slug = ${SHEPHERD_SLUG}
        ORDER BY a.archived_at IS NOT NULL, a.updated_at DESC LIMIT 1) AS shepherd,
      (SELECT json_build_object('enabled', b.enabled = 1, 'encrypted', c.encrypted_value)
        FROM api_bindings b LEFT JOIN api_credentials c
          ON c.space_id = b.space_id AND c.credential_key = b.auth_json->>'credentialKey'
        WHERE b.space_id = ${spaceId}::uuid AND b.api_id = 'github'
        ORDER BY b.enabled DESC, c.encrypted_value IS NULL LIMIT 1) AS github,
      (SELECT json_agg(json_build_object(
          'status', s.status, 'cronExpression', s.cron_expression, 'maxFirings', s.max_firings,
          'firingCount', s.firing_count, 'expiresAt', s.expires_at,
          'inputTemplate', s.input_template,
          'renews', COALESCE(s.input_template -> 'config' -> 'scheduleId' = '{"$schedule":"id"}'::jsonb, false),
          'failure', CASE
            WHEN s.last_error IS NOT NULL THEN s.last_error
            WHEN EXISTS (SELECT 1 FROM sessions e WHERE e.session_id = s.last_session_id
                  AND e.space_id = s.space_id AND e.status = 'FAILED')
              OR EXISTS (SELECT 1 FROM workflow_runs r WHERE r.session_id = s.last_session_id
                  AND r.space_id = s.space_id AND r.status = 'failed')
            THEN 'The latest shepherd execution failed.' END
        ) ORDER BY s.created_at DESC)
        FROM agent_schedules s JOIN agents a ON a.id = s.target_agent_id AND a.space_id = s.space_id
        WHERE s.space_id = ${spaceId}::uuid AND a.slug = ${SHEPHERD_SLUG}
          AND a.archived_at IS NULL AND s.kind = 'cron' AND s.status <> 'deleted') AS schedules
  `);
  const github = row?.github ?? null;
  const encrypted = github?.encrypted ?? null;
  let answer: GithubCredentialAnswer | null = null;
  if (readings.has('github_credential') && github?.enabled && encrypted !== null) {
    const fingerprint = githubCredentialFingerprint(encrypted);
    answer =
      opts.githubAnswers?.get(fingerprint) ?? (await keptGithubAnswer(fingerprint, opts.redis));
  }
  return {
    spaceId,
    hostLane: opts.hostLane,
    now: opts.now ?? Date.now(),
    inventories,
    folders: row?.folders ?? [],
    preferredHarness: row?.preferred_harness ?? null,
    shepherd: row?.shepherd ?? null,
    github:
      github === null
        ? null
        : { enabled: github.enabled, credentialPresent: encrypted !== null, answer },
    schedules: row?.schedules ?? [],
  };
}

// ============================================================================
// The readings — pure, so every transition is tested without a database
// ============================================================================

type Task<K extends PostInstallTask['kind']> = Extract<PostInstallTask, { kind: K }>;

/** Item 1: the machine reading of the host lane's grant. */
export function readMachine(facts: ReadinessFacts): Task<'pair_machine'> {
  const base = {
    kind: 'pair_machine',
    reading: 'machine',
    page: '/computer',
    required: true,
  } as const;
  if (facts.hostLane !== 'present') {
    return { ...base, state: 'broken', description: HOST_LANE_PAIRING_REFUSAL };
  }
  if (facts.inventories.length > 0) {
    const names = externalText(facts.inventories.map((inventory) => inventory.hostname).join(', '));
    return { ...base, state: 'done', description: `Paired: ${names} is running its executor.` };
  }
  if (facts.folders.length > 0) {
    return {
      ...base,
      state: 'broken',
      description:
        "This space's folders were connected from a paired machine whose executor is no longer " +
        'running, so nothing can reach them. Start it on that machine, or pair this machine ' +
        'again under This Computer → Get a code.',
    };
  }
  return {
    ...base,
    state: 'needs_setup',
    description:
      'Pair this machine under This Computer → Get a code, and keep its executor running.',
  };
}

function offeredFolders(facts: ReadinessFacts): Map<string, HostMergePosture> {
  const offered = new Map<string, HostMergePosture>();
  for (const inventory of facts.inventories) {
    for (const folder of inventory.folders) {
      if (folder.spaceId === facts.spaceId && !offered.has(folder.id)) {
        offered.set(folder.id, folder.mergePosture);
      }
    }
  }
  return offered;
}

/**
 * Item 2: the folder reading of the same grant. Where the folder is the one the
 * loop publishes from (`pushes`), it reads whether it pushes, under which
 * prefix and merge posture, and, where the shepherd is part of the space's
 * loop, whether its agent was written before the folder was connected (§7 F4).
 * Otherwise a connected folder is enough: a skill that only reads and runs
 * there needs no push.
 */
export function readFolder(
  facts: ReadinessFacts,
  opts: { pushes: boolean; shepherd: boolean },
): Task<'pair_machine'> {
  const base = {
    kind: 'pair_machine',
    reading: 'folder',
    page: '/computer',
    ...(opts.pushes ? { command: HOST_FOLDER_CONNECT_COMMAND } : {}),
    required: true,
  } as const;
  if (facts.hostLane !== 'present') {
    return { ...base, state: 'broken', description: HOST_LANE_FOLDER_REFUSAL };
  }
  const [first] = facts.folders;
  if (first === undefined && !opts.pushes) {
    return {
      ...base,
      state: 'needs_setup',
      description:
        'Connect the folder these skills work in from the machine that holds it, under This ' +
        'Computer → Get a code.',
    };
  }
  if (first === undefined) {
    return {
      ...base,
      state: 'needs_setup',
      description:
        "Connect the repository's folder from the machine that holds it, allowing writes, " +
        'commands and pushes under a branch prefix, and choose its merge posture: run the ' +
        'command in the folder, with the code This Computer → Get a code shows.',
    };
  }
  const offered = offeredFolders(facts);
  const pushing = facts.folders.filter(
    (folder) => folder.allowsExecution && folder.branchPrefix !== null,
  );
  const chosen = pushing.find((folder) => offered.has(folder.id)) ?? pushing[0] ?? first;
  const folder = {
    label: chosen.label,
    allowsPush: pushing.includes(chosen),
    branchPrefix: chosen.branchPrefix,
    mergePosture: offered.get(chosen.id) ?? null,
  };
  if (!opts.pushes) {
    return {
      ...base,
      folder,
      state: 'done',
      description: `${chosen.label} is connected.`,
    };
  }
  if (!folder.allowsPush) {
    return {
      ...base,
      folder,
      state: 'needs_setup',
      description:
        `${chosen.label} does not allow pushes. Connect it again allowing commands, with a ` +
        'branch prefix and a merge posture.',
    };
  }
  const prefix = chosen.branchPrefix ?? '';
  if (folder.mergePosture === null) {
    return {
      ...base,
      folder,
      state: 'needs_setup',
      description:
        `${chosen.label} pushes under ${prefix}, but no running machine offers it, so its merge ` +
        "posture cannot be read. Start the machine's executor, or connect the folder again.",
    };
  }
  if (opts.shepherd) {
    const newestPushing = Math.max(
      ...pushing.map((candidate) => Date.parse(candidate.connectedAt)),
    );
    if (facts.shepherd === null) {
      return {
        ...base,
        folder,
        page: '/store/coding-loop',
        state: 'needs_setup',
        description:
          'The Local PR Shepherd agent was not written, because no folder allowed pushes when ' +
          `Coding Loop was installed. Choose Repair installation on the Coding Loop listing to write it for ${chosen.label}.`,
      };
    }
    const writtenAt =
      facts.shepherd.writtenAt === null ? NaN : Date.parse(facts.shepherd.writtenAt);
    if (!facts.shepherd.archived && writtenAt < newestPushing) {
      return {
        ...base,
        folder,
        shepherdBeforeFolder: true,
        page: '/agents',
        state: 'needs_setup',
        description:
          'The Local PR Shepherd agent was written before this folder was connected, and its ' +
          'folders are fixed when it is written, so it does not tend it. Delete the agent under ' +
          'Agents, then choose Repair installation on the Coding Loop listing to write it again.',
      };
    }
  }
  return {
    ...base,
    folder,
    state: 'done',
    description: `${chosen.label} pushes under ${prefix}, with the merge posture ${folder.mergePosture}.`,
  };
}

/** Item 3: the github binding's credential, as GitHub answers for it. */
export function readGithubCredential(facts: ReadinessFacts): Task<'github_credential'> {
  const base = {
    kind: 'github_credential',
    page: '/integrations',
    missingScopes: [] as string[],
    required: true,
  } as const;
  const github = facts.github;
  if (github === null) {
    return {
      ...base,
      state: 'needs_setup',
      description: `Bind a GitHub credential to the github connector under Integrations. ${GITHUB_PERMISSIONS}`,
    };
  }
  if (!github.enabled) {
    return {
      ...base,
      state: 'needs_setup',
      description: 'Enable the github connection under Integrations.',
    };
  }
  if (!github.credentialPresent) {
    return {
      ...base,
      state: 'needs_setup',
      description: `The github connection has no credential: add one under Integrations. ${GITHUB_PERMISSIONS}`,
    };
  }
  const answer = github.answer;
  if (answer === null) {
    return {
      ...base,
      state: 'needs_setup',
      description:
        'GitHub has not been asked about this credential yet. Check setup again, or open the ' +
        'Coding Loop listing, to ask it.',
    };
  }
  if (answer.kind === 'refused') {
    return {
      ...base,
      state: 'broken',
      description: `GitHub refuses this credential (${String(answer.status)}: ${externalText(answer.message)}). Bind a working token under Integrations.`,
    };
  }
  if (answer.kind === 'unreachable') {
    return {
      ...base,
      state: 'needs_setup',
      description: `GitHub could not be asked about this credential: ${externalText(answer.message)}. Check setup again once it answers.`,
    };
  }
  if (answer.scopes === null) {
    return {
      ...base,
      state: 'done',
      description:
        'GitHub accepts this credential. It lists no scopes for a fine-grained or GitHub App ' +
        `token, so a missing permission shows on the first call GitHub refuses. ${GITHUB_PERMISSIONS}`,
    };
  }
  if (!answer.scopes.some((scope) => CLASSIC_REPOSITORY_SCOPES.includes(scope))) {
    return {
      ...base,
      missingScopes: ['repo'],
      state: 'needs_setup',
      description:
        `GitHub reports this classic token's scopes as ${externalText(answer.scopes.join(', ')) || 'none'}; ` +
        'publish and the shepherd need repo (public_repo for public repositories). Bind a ' +
        'token with it under Integrations.',
    };
  }
  return {
    ...base,
    state: 'done',
    description: `GitHub accepts this credential with the scopes ${externalText(answer.scopes.join(', '))}.`,
  };
}

function harnessLabel(id: string): string {
  return CODING_HARNESS_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

/** Item 4: the space's preferred harness against what the running machines have installed. */
export function readCodingHarness(facts: ReadinessFacts): Task<'coding_harness'> {
  const base = { kind: 'coding_harness', page: '/computer', required: true } as const;
  const chosen = facts.preferredHarness;
  if (facts.hostLane !== 'present') {
    return {
      ...base,
      chosen,
      options: [],
      state: 'broken',
      description: HOST_LANE_HARNESS_REFUSAL,
    };
  }
  const installed = new Set(
    facts.inventories.flatMap((inventory) =>
      inventory.harnesses.filter((harness) => harness.installed).map((harness) => harness.id),
    ),
  );
  const options = CODING_HARNESS_OPTIONS.filter((option) => installed.has(option.id)).map(
    (option) => ({ ...option }),
  );
  if (chosen === null) {
    return {
      ...base,
      chosen,
      options,
      state: 'needs_setup',
      description:
        options.length > 0
          ? `Choose the coding agent this space runs under This Computer → Coding agent: ${options.map((option) => option.label).join(' or ')} is installed.`
          : 'Neither Claude Code nor Codex is installed on a running machine. Install one there, then choose it under This Computer → Coding agent.',
    };
  }
  if (!installed.has(chosen)) {
    return {
      ...base,
      chosen,
      options,
      state: 'broken',
      description: `${harnessLabel(chosen)} is this space's coding agent, but no running machine has it installed. Install it, or choose another under This Computer → Coding agent.`,
    };
  }
  return {
    ...base,
    chosen,
    options,
    state: 'done',
    description: `${harnessLabel(chosen)} runs this space's coding work.`,
  };
}

function scheduleExpired(schedule: ReadinessSchedule, now: number): boolean {
  if (schedule.status === 'expired') return true;
  if (schedule.expiresAt !== null && Date.parse(schedule.expiresAt) <= now) return true;
  return schedule.maxFirings !== null && schedule.firingCount >= schedule.maxFirings;
}

function firingsLeft(schedule: ReadinessSchedule): number | null {
  return schedule.maxFirings === null
    ? null
    : Math.max(0, schedule.maxFirings - schedule.firingCount);
}

/**
 * Item 5: the shepherd's schedule. Absent, it offers the input that creates it
 * — the agent, `SHEPHERD_SCHEDULE_CRON_DEFAULT` and the firings cap, and the
 * renewal input — which the operator's word turns into the schedule. Expired,
 * it offers the same from what the expired schedule stored.
 */
export function readShepherdSchedule(facts: ReadinessFacts): Task<'shepherd_schedule'> {
  const base = { kind: 'shepherd_schedule', page: '/triggers', required: true } as const;
  const shepherd = facts.shepherd;
  if (shepherd === null) {
    return {
      ...base,
      page: '/store/coding-loop',
      state: 'needs_setup',
      description:
        'The Local PR Shepherd agent this schedule starts is not written yet. Connect the ' +
        'folder, then choose Repair installation on the Coding Loop listing.',
    };
  }
  if (shepherd.archived) {
    return {
      ...base,
      page: '/agents',
      state: 'needs_setup',
      description: 'Restore the archived Local PR Shepherd agent before arming its schedule.',
    };
  }
  const offer = (from?: ReadinessSchedule): ShepherdScheduleInput => ({
    agentId: shepherd.id,
    cronExpression: from?.cronExpression ?? SHEPHERD_SCHEDULE_CRON_DEFAULT,
    maxFirings: from === undefined ? MAX_FIRINGS_CAP : from.maxFirings,
    inputTemplate: from?.renews ? from.inputTemplate : SHEPHERD_RENEWAL_INPUT,
  });
  // Any live schedule of the shepherd counts, whether or not its input renews
  // it: offering to arm another would start a second one beside it.
  const live = facts.schedules.find(
    (schedule) => schedule.status === 'active' && !scheduleExpired(schedule, facts.now),
  );
  if (live !== undefined) {
    if (live.failure !== null) {
      return {
        ...base,
        firingsLeft: firingsLeft(live),
        state: 'broken',
        description: `The shepherd schedule is armed but failing: ${externalText(live.failure)} Inspect it under Triggers.`,
      };
    }
    const left = firingsLeft(live);
    const cron = live.cronExpression ?? SHEPHERD_SCHEDULE_CRON_DEFAULT;
    return {
      ...base,
      firingsLeft: left,
      state: 'done',
      description: live.renews
        ? `Armed on ${cron}` +
          (left === null ? '.' : `, ${String(left)} firings left before it renews itself.`)
        : `Armed on ${cron}` +
          (left === null ? '' : `, ${String(left)} firings left`) +
          '. Its input does not hand a pass the schedule, so it ends without renewing itself; ' +
          'once it has, the checklist recreates it with the input that renews.',
    };
  }
  const [latest] = facts.schedules;
  if (latest?.status === 'paused') {
    return {
      ...base,
      firingsLeft: firingsLeft(latest),
      state: 'needs_setup',
      description: 'The shepherd schedule is paused. Resume it under Triggers.',
    };
  }
  if (latest !== undefined) {
    const stored = offer(latest);
    return {
      ...base,
      firingsLeft: 0,
      schedule: stored,
      state: 'broken',
      description:
        'The shepherd schedule expired, so nothing tends the pull requests the loop opens. ' +
        `Recreate it from what it stored: ${stored.cronExpression}` +
        (stored.maxFirings === null ? '.' : `, ${String(stored.maxFirings)} firings.`),
    };
  }
  return {
    ...base,
    schedule: offer(),
    state: 'needs_setup',
    description:
      `Arm the shepherd schedule: it starts the Local PR Shepherd on ${SHEPHERD_SCHEDULE_CRON_DEFAULT}, ` +
      `at most ${String(MAX_FIRINGS_CAP)} times before it renews itself. Nothing is scheduled until you arm it.`,
  };
}

/** The readings asked for, in the order they are listed. */
export function readinessTasks(
  facts: ReadinessFacts,
  readings: ReadonlySet<ReadinessReading>,
): PostInstallTask[] {
  const shepherd = readings.has('shepherd_schedule');
  const publishing = readings.has('publishing_folder');
  const tasks: PostInstallTask[] = [];
  for (const reading of READINESS_READINGS) {
    if (!readings.has(reading)) continue;
    // The publishing folder is a connected folder too, so it answers for both.
    if (reading === 'folder' && publishing) continue;
    if (reading === 'machine') tasks.push(readMachine(facts));
    else if (reading === 'folder')
      tasks.push(readFolder(facts, { pushes: false, shepherd: false }));
    else if (reading === 'publishing_folder')
      tasks.push(readFolder(facts, { pushes: true, shepherd }));
    else if (reading === 'github_credential') tasks.push(readGithubCredential(facts));
    else if (reading === 'coding_harness') tasks.push(readCodingHarness(facts));
    else tasks.push(readShepherdSchedule(facts));
  }
  return tasks;
}
