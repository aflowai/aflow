/**
 * Where a proposal came from, as a reader is shown it. A proposal records the
 * session or run that wrote it (`coachSessionId`, `evidence.sourceSessionIds`).
 * This module resolves those ids to the conversation that holds them, and the
 * target slug to the skill's name. The withdraw rule reads the same
 * conversation, so the card and the rule cannot disagree.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  querySkillDiscovery,
  sessions,
  withTenantSchema,
  workflowRuns,
} from '@aflow/database';
import {
  proposalAuthorRole,
  proposalSourceLabel,
  proposalWithdrawnBy,
  resolveStagedChangeSource,
  type ProposalProvenance,
  type StagedChange,
  type TenantId,
} from '@aflow/schemas';
import { createLogger } from '@aflow/observability';

export type ProposalConversation = NonNullable<ProposalProvenance['conversation']>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATOR_SENTINEL_SESSION = '00000000-0000-0000-0000-000000000000';
/** A delegated session's chain is short. The bound stops a cycle in bad data. */
const MAX_PARENT_HOPS = 8;

export interface ConversationSessionRow {
  sessionId: string;
  parentSessionId: string | null;
  title: string | null;
  manualTitle: string | null;
}

/** What the store answers: sessions in this space by id, and the session that started each run. */
export interface ConversationLookup {
  sessions: ReadonlyMap<string, ConversationSessionRow>;
  runSessions: ReadonlyMap<string, string>;
}

const EMPTY_LOOKUP: ConversationLookup = { sessions: new Map(), runSessions: new Map() };

/** The ids a proposal names as its author, the writing session first. */
export function proposalAuthorIds(sc: StagedChange): string[] {
  const ids = [sc.coachSessionId, ...sc.evidence.sourceSessionIds];
  return [...new Set(ids.filter((id) => id !== OPERATOR_SENTINEL_SESSION))];
}

/**
 * The conversation a session or run id belongs to. A run resolves to the
 * session that started it, and a delegated session to the conversation at
 * the top of its chain.
 */
export function conversationOfId(
  id: string,
  lookup: ConversationLookup,
): ProposalConversation | null {
  let row = lookup.sessions.get(id);
  if (!row) {
    const startedBy = lookup.runSessions.get(id);
    row = startedBy ? lookup.sessions.get(startedBy) : undefined;
  }
  if (!row) return null;
  for (let hop = 0; hop < MAX_PARENT_HOPS && row.parentSessionId; hop++) {
    const parent = lookup.sessions.get(row.parentSessionId);
    if (!parent) break;
    row = parent;
  }
  return { sessionId: row.sessionId, title: row.manualTitle ?? row.title };
}

/** The conversation a proposal came from: that of the first author id the space holds. */
export function conversationFor(
  sc: StagedChange,
  lookup: ConversationLookup,
): ProposalConversation | null {
  for (const id of proposalAuthorIds(sc)) {
    const conversation = conversationOfId(id, lookup);
    if (conversation) return conversation;
  }
  return null;
}

/**
 * Whether `sessionId` belongs to the conversation the proposal came from: the
 * same conversation its card names. A session the space does not hold
 * matches only the id the proposal records.
 */
export function isProposalOfConversation(
  sc: StagedChange,
  sessionId: string,
  lookup: ConversationLookup,
): boolean {
  if (sc.coachSessionId === sessionId) return true;
  const proposer = conversationFor(sc, lookup);
  const caller = conversationOfId(sessionId, lookup);
  return proposer !== null && caller !== null && proposer.sessionId === caller.sessionId;
}

export function provenanceOf(
  sc: StagedChange,
  conversation: ProposalConversation | null,
  targetName: string | null = null,
): ProposalProvenance {
  return {
    source: resolveStagedChangeSource(sc),
    sourceLabel: proposalSourceLabel(sc),
    conversation,
    authorRole: proposalAuthorRole(sc),
    authorId: proposalAuthorIds(sc)[0] ?? null,
    target: sc.targetWorkflowSlug ? { slug: sc.targetWorkflowSlug, name: targetName } : null,
    withdrawnBy: proposalWithdrawnBy(sc),
  };
}

async function loadSessions(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  ids: readonly string[],
): Promise<ConversationSessionRow[]> {
  const uuids = ids.filter((id) => UUID_PATTERN.test(id));
  if (uuids.length === 0) return [];
  return withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
    tx
      .select({
        sessionId: sessions.sessionId,
        parentSessionId: sessions.parentSessionId,
        title: sessions.title,
        manualTitle: sessions.manualTitle,
      })
      .from(sessions)
      .where(and(inArray(sessions.sessionId, uuids), eq(sessions.spaceId, spaceId))),
  );
}

/** The sessions and runs behind `ids`, with every session above them, read from this space. */
export async function loadConversationLookup(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  ids: readonly string[],
): Promise<ConversationLookup> {
  const unique = [...new Set(ids)];
  const found = new Map<string, ConversationSessionRow>();
  const runSessions = new Map<string, string>();
  for (const row of await loadSessions(db, tenantId, spaceId, unique))
    found.set(row.sessionId, row);

  const unresolved = unique.filter((id) => !found.has(id));
  if (unresolved.length > 0) {
    const runs = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
      tx
        .select({ runId: workflowRuns.runId, sessionId: workflowRuns.sessionId })
        .from(workflowRuns)
        .where(and(inArray(workflowRuns.runId, unresolved), eq(workflowRuns.spaceId, spaceId))),
    );
    for (const run of runs) if (run.sessionId) runSessions.set(run.runId, run.sessionId);
  }

  let next = [...runSessions.values()].filter((id) => !found.has(id));
  for (const row of found.values()) {
    if (row.parentSessionId && !found.has(row.parentSessionId)) next.push(row.parentSessionId);
  }
  for (let hop = 0; hop <= MAX_PARENT_HOPS && next.length > 0; hop++) {
    const rows = await loadSessions(db, tenantId, spaceId, [...new Set(next)]);
    next = [];
    for (const row of rows) {
      found.set(row.sessionId, row);
      if (row.parentSessionId && !found.has(row.parentSessionId)) next.push(row.parentSessionId);
    }
  }
  return { sessions: found, runSessions };
}

async function loadSkillNames(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  slugs: readonly string[],
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const { skills } = await querySkillDiscovery(db, tenantId as TenantId, spaceId, {
    onlySlugs: [...slugs],
    limit: slugs.length,
  });
  return new Map(skills.map((skill) => [skill.slug, skill.name]));
}

/**
 * Provenance for each proposal, keyed by proposal id. A failed lookup leaves
 * out what it would have resolved: the proposal still shows, with its source
 * and reason.
 */
export async function resolveProposalProvenance(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  staged: readonly StagedChange[],
): Promise<Map<string, ProposalProvenance>> {
  const log = createLogger({ component: 'proposal-provenance' });
  const failed = (what: string) => (err: unknown) => {
    log.warn(`proposal provenance: ${what} lookup failed`, {
      tenantId,
      spaceId,
      proposalCount: staged.length,
      error: err instanceof Error ? err.message : String(err),
    });
  };
  const slugs = [
    ...new Set(staged.flatMap((sc) => (sc.targetWorkflowSlug ? [sc.targetWorkflowSlug] : []))),
  ];
  const [lookup, skillNames] = await Promise.all([
    loadConversationLookup(db, tenantId, spaceId, staged.flatMap(proposalAuthorIds)).catch(
      (err: unknown) => {
        failed('conversation')(err);
        return EMPTY_LOOKUP;
      },
    ),
    loadSkillNames(db, tenantId, spaceId, slugs).catch((err: unknown) => {
      failed('skill name')(err);
      return new Map<string, string>();
    }),
  ]);
  return new Map(
    staged.map((sc) => [
      sc.id,
      provenanceOf(
        sc,
        conversationFor(sc, lookup),
        sc.targetWorkflowSlug ? (skillNames.get(sc.targetWorkflowSlug) ?? null) : null,
      ),
    ]),
  );
}
