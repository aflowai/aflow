/**
 * Who proposed a change, and the conversation it came from, as a reader is
 * shown it. A proposal records the session or run that wrote it
 * (`coachSessionId`, `evidence.sourceSessionIds`). This module resolves those
 * ids to the conversation that holds them, and to that conversation's title.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, sessions, withTenantSchema, workflowRuns } from '@aflow/database';
import {
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

/** The ids a proposal names as its author, the writing session first. */
export function proposalAuthorIds(sc: StagedChange): string[] {
  const ids = [sc.coachSessionId, ...sc.evidence.sourceSessionIds];
  return [...new Set(ids.filter((id) => id !== OPERATOR_SENTINEL_SESSION))];
}

/**
 * The conversation an author id belongs to. A run resolves to the session
 * that started it, and a delegated session to the conversation at the top.
 */
export function conversationFor(
  sc: StagedChange,
  lookup: ConversationLookup,
): ProposalConversation | null {
  for (const id of proposalAuthorIds(sc)) {
    let row = lookup.sessions.get(id);
    if (!row) {
      const startedBy = lookup.runSessions.get(id);
      row = startedBy ? lookup.sessions.get(startedBy) : undefined;
    }
    if (!row) continue;
    for (let hop = 0; hop < MAX_PARENT_HOPS && row.parentSessionId; hop++) {
      const parent = lookup.sessions.get(row.parentSessionId);
      if (!parent) break;
      row = parent;
    }
    return { sessionId: row.sessionId, title: row.manualTitle ?? row.title };
  }
  return null;
}

export function provenanceOf(
  sc: StagedChange,
  conversation: ProposalConversation | null,
): ProposalProvenance {
  return { source: resolveStagedChangeSource(sc), conversation };
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

async function loadLookup(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  staged: readonly StagedChange[],
): Promise<ConversationLookup> {
  const ids = [...new Set(staged.flatMap(proposalAuthorIds))];
  const found = new Map<string, ConversationSessionRow>();
  const runSessions = new Map<string, string>();
  for (const row of await loadSessions(db, tenantId, spaceId, ids)) found.set(row.sessionId, row);

  const unresolved = ids.filter((id) => !found.has(id));
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

/**
 * Provenance for each proposal, keyed by proposal id. A failed lookup leaves
 * the conversation out: the proposal still shows, with its source and reason.
 */
export async function resolveProposalProvenance(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  staged: readonly StagedChange[],
): Promise<Map<string, ProposalProvenance>> {
  let lookup: ConversationLookup = { sessions: new Map(), runSessions: new Map() };
  try {
    lookup = await loadLookup(db, tenantId, spaceId, staged);
  } catch (err) {
    createLogger({ component: 'proposal-provenance' }).warn(
      'proposal provenance: conversation lookup failed',
      {
        tenantId,
        spaceId,
        proposalCount: staged.length,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
  return new Map(staged.map((sc) => [sc.id, provenanceOf(sc, conversationFor(sc, lookup))]));
}
