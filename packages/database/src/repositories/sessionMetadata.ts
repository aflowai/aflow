/**
 * The conversation-metadata store: one reader, three writers, and the bounded
 * evidence query a generation is produced from.
 *
 * The generated half and the manual half are written by different callers and
 * never contend — they own different columns, and the resolved title is picked
 * at read. `metadata_revision` is therefore not a lock between them; it is the
 * handle two people renaming the same conversation collide on.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  RoomMessageMetadataSchema,
  parseSessionMetadataRecord,
  type SessionMetadataDiagnostic,
  type SessionMetadataProvenance,
  type SessionMetadataRecord,
  type SessionSummaryCoverage,
  type SessionTitleState,
  type TenantId,
} from '@aflow/schemas';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { eventLog, sessions } from '../schema/tenant/sessions.js';

export interface StoredSessionMetadata {
  sessionId: string;
  spaceId: string | null;
  createdBy: string | null;
  executionAuthority: unknown;
  status: string;
  startedAt: Date;
  lastActivityAt: Date | null;
  title: string | null;
  titleState: SessionTitleState | null;
  manualTitle: string | null;
  summary: string | null;
  summaryCoverage: SessionSummaryCoverage | null;
  metadataRevision: number;
  metadataEvidenceRevision: number | null;
  metadataUpdatedAt: Date | null;
  metadataEditedBy: string | null;
  record: SessionMetadataRecord;
}

const METADATA_COLUMNS = {
  sessionId: sessions.sessionId,
  spaceId: sessions.spaceId,
  createdBy: sessions.createdBy,
  executionAuthority: sessions.executionAuthority,
  status: sessions.status,
  startedAt: sessions.startedAt,
  lastActivityAt: sessions.lastActivityAt,
  title: sessions.title,
  titleState: sessions.titleState,
  manualTitle: sessions.manualTitle,
  summary: sessions.summary,
  summaryCoverage: sessions.summaryCoverage,
  metadataRevision: sessions.metadataRevision,
  metadataEvidenceRevision: sessions.metadataEvidenceRevision,
  metadataUpdatedAt: sessions.metadataUpdatedAt,
  metadataEditedBy: sessions.metadataEditedBy,
  metadataJson: sessions.metadataJson,
};

type MetadataRow = {
  [K in keyof typeof METADATA_COLUMNS]: unknown;
};

function toStored(row: MetadataRow): StoredSessionMetadata {
  return {
    sessionId: row.sessionId as string,
    spaceId: (row.spaceId as string | null) ?? null,
    createdBy: (row.createdBy as string | null) ?? null,
    executionAuthority: row.executionAuthority,
    status: row.status as string,
    startedAt: row.startedAt as Date,
    lastActivityAt: (row.lastActivityAt as Date | null) ?? null,
    title: (row.title as string | null) ?? null,
    titleState: (row.titleState as SessionTitleState | null) ?? null,
    manualTitle: (row.manualTitle as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    summaryCoverage: (row.summaryCoverage as SessionSummaryCoverage | null) ?? null,
    metadataRevision: Number(row.metadataRevision ?? 0),
    metadataEvidenceRevision:
      row.metadataEvidenceRevision == null ? null : Number(row.metadataEvidenceRevision),
    metadataUpdatedAt: (row.metadataUpdatedAt as Date | null) ?? null,
    metadataEditedBy: (row.metadataEditedBy as string | null) ?? null,
    record: parseSessionMetadataRecord(row.metadataJson),
  };
}

export async function readSessionMetadata(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
): Promise<StoredSessionMetadata | null> {
  const rows = await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    (tx: PostgresJsDatabase) =>
      tx.select(METADATA_COLUMNS).from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1),
  );
  const row = rows[0];
  return row ? toStored(row as MetadataRow) : null;
}

/**
 * Apply a generated title and summary.
 *
 * Every field is optional and written only when supplied: a summary-only
 * refresh must not blank an established title, and a title-only first pass
 * must not blank a summary someone is reading. `metadata_evidence_revision`
 * records what the generation actually saw, so a later read can tell a current
 * summary from one that predates the last exchange.
 *
 * Deliberately does NOT bump `metadata_revision`. That number is the handle
 * two people renaming at once collide on, and it means "how many times a
 * person has named this". A background write advancing it would tell whoever
 * was midway through a rename that somebody else had renamed the
 * conversation, which nobody had.
 */
export interface GeneratedSessionMetadataWrite {
  title?: string;
  titleState?: SessionTitleState;
  summary?: string;
  summaryCoverage?: SessionSummaryCoverage;
  evidenceRevision: number;
  provenance?: SessionMetadataProvenance;
  /** Cleared when omitted — a successful generation retires the last complaint. */
  diagnostic?: SessionMetadataDiagnostic;
}

export async function applyGeneratedSessionMetadata(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
  write: GeneratedSessionMetadataWrite,
): Promise<boolean> {
  const record: SessionMetadataRecord = {
    ...(write.provenance ? { provenance: write.provenance } : {}),
    ...(write.diagnostic ? { diagnostic: write.diagnostic } : {}),
  };
  const updated = await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    (tx: PostgresJsDatabase) =>
      tx
        .update(sessions)
        .set({
          ...(write.title !== undefined ? { title: write.title } : {}),
          ...(write.titleState !== undefined ? { titleState: write.titleState } : {}),
          ...(write.summary !== undefined ? { summary: write.summary } : {}),
          ...(write.summaryCoverage !== undefined
            ? { summaryCoverage: write.summaryCoverage }
            : {}),
          metadataEvidenceRevision: write.evidenceRevision,
          metadataUpdatedAt: new Date(),
          metadataJson: record,
        })
        .where(eq(sessions.sessionId, sessionId))
        .returning({ sessionId: sessions.sessionId }),
  );
  return updated.length > 0;
}

/**
 * Record why a generation did not happen, without touching what is shown.
 *
 * Deliberately does NOT bump `metadata_revision`: a diagnostic is not a change
 * to the conversation's name, and bumping would invalidate a rename someone is
 * mid-way through for no reason a person could see.
 */
export async function recordSessionMetadataDiagnostic(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
  diagnostic: SessionMetadataDiagnostic,
): Promise<void> {
  await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx: PostgresJsDatabase) =>
    tx
      .update(sessions)
      .set({
        metadataJson: sql`
          COALESCE(${sessions.metadataJson}, '{}'::jsonb)
            || ${JSON.stringify({ diagnostic })}::jsonb
        `,
      })
      .where(eq(sessions.sessionId, sessionId)),
  );
}

/**
 * Put an established name back to `provisional`, so the next generation
 * replaces it.
 *
 * What makes "Regenerate name" regenerate the name. Without it an established
 * title is left alone by design — a name someone has learned to recognize is
 * worth more than a marginally better one — and an explicit request would
 * quietly rewrite only the summary, which is not what the action says it does.
 *
 * The shown name stays put in the meantime rather than blanking: the operator
 * asked for a better one, not for none.
 */
export async function markSessionTitleRefreshable(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx: PostgresJsDatabase) =>
    tx
      .update(sessions)
      .set({ titleState: 'provisional' })
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.titleState, 'established'))),
  );
}

export type SessionRenameResult =
  { ok: true; revision: number } | { ok: false; reason: 'not_found' | 'conflict' };

/**
 * Name a conversation, or hand it back to the automatic one.
 *
 * `expectedRevision` is how two people renaming at once find out: the loser is
 * told rather than silently overwritten. Passing none is an unconditional
 * write, which the regenerate path does not need and the UI never does.
 */
export async function setManualSessionTitle(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
  args: { title: string | null; editedByUserId: string; expectedRevision?: number },
): Promise<SessionRenameResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const updated = await withTenantSchema(db, tenantCtx, (tx: PostgresJsDatabase) =>
    tx
      .update(sessions)
      .set({
        manualTitle: args.title,
        metadataEditedBy: args.title === null ? null : args.editedByUserId,
        metadataUpdatedAt: new Date(),
        metadataRevision: sql`${sessions.metadataRevision} + 1`,
      })
      .where(
        args.expectedRevision === undefined
          ? eq(sessions.sessionId, sessionId)
          : and(
              eq(sessions.sessionId, sessionId),
              eq(sessions.metadataRevision, args.expectedRevision),
            ),
      )
      .returning({ revision: sessions.metadataRevision }),
  );
  const row = updated[0];
  if (row) return { ok: true, revision: row.revision };

  const exists = await withTenantSchema(db, tenantCtx, (tx: PostgresJsDatabase) =>
    tx
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1),
  );
  return { ok: false, reason: exists.length > 0 ? 'conflict' : 'not_found' };
}

// ============================================================================
// Evidence
// ============================================================================

/**
 * Rows read per requested turn. A window can be mostly tool traffic and
 * lifecycle noise, none of which is a turn, so asking for exactly the turn
 * count would report a conversation as fully read after seeing a fraction of
 * it.
 */
const EVIDENCE_ROW_OVERFETCH = 4;

/**
 * The event types a conversation's committed turns can arrive on.
 *
 * A person speaks through a start, a resume or a room post; the agent answers
 * through the pause it parks on, the completion it ends at, or — for a
 * delegated child whose events are forwarded upward — a step-succeeded. Tool
 * traffic and reasoning are structurally absent: none of it is one of these.
 */
const EVIDENCE_EVENT_TYPES = [
  'SessionStarted',
  'SessionResumed',
  'RoomMessage',
  'SessionPaused',
  'SessionCompleted',
  'StepSucceeded',
] as const;

export interface SessionEvidenceExchange {
  speaker: 'person' | 'agent';
  text: string;
  at: number;
}

export interface SessionEvidence {
  /** The request that opened the conversation, where the log still holds it. */
  openingRequest: string | null;
  /** Committed turns, oldest first, bounded by the caller's limit. */
  exchanges: SessionEvidenceExchange[];
  /** False when the window cut off older turns the summary therefore misses. */
  complete: boolean;
}

/**
 * The bounded, committed record of what was said.
 *
 * Read from `event_log` rather than from the agent's conversation payload for
 * three reasons that all matter to a background reader: it survives the
 * payload store's retention, it is readable for a session long gone cold
 * without rehydrating anything, and it holds what people actually said rather
 * than the compacted form the model is given. Compaction serves the model; a
 * summary written from it would be a summary of a summary.
 *
 * Tool traffic, reasoning, and system text are structurally absent — none of
 * it is one of these four event types.
 */
export async function readSessionEvidence(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
  limit: number,
): Promise<SessionEvidence> {
  const tenantCtx = createTenantContext(tenantId as TenantId);

  const [opening, recent] = await Promise.all([
    withTenantSchema(db, tenantCtx, (tx: PostgresJsDatabase) =>
      tx
        .select({ envelope: eventLog.envelope, timestamp: eventLog.timestamp })
        .from(eventLog)
        .where(and(eq(eventLog.sessionId, sessionId), eq(eventLog.eventType, 'SessionStarted')))
        .orderBy(eventLog.timestamp)
        .limit(1),
    ),
    // Newest-first so the bound keeps the end someone is waiting on, then back
    // into reading order below.
    withTenantSchema(db, tenantCtx, (tx: PostgresJsDatabase) =>
      tx
        .select({
          eventType: eventLog.eventType,
          envelope: eventLog.envelope,
          timestamp: eventLog.timestamp,
        })
        .from(eventLog)
        .where(
          and(eq(eventLog.sessionId, sessionId), inArray(eventLog.eventType, EVIDENCE_EVENT_TYPES)),
        )
        .orderBy(desc(eventLog.timestamp))
        .limit(limit * EVIDENCE_ROW_OVERFETCH + 1),
    ),
  ]);

  const openingRequest = readPersonText(opening[0]?.envelope);

  // Whether the query saw everything the log holds for this session, or was
  // itself cut off. Without this, a window full of tool-only step events
  // yields few turns and would be reported as complete coverage of a
  // conversation it barely read.
  const sawEveryRow = recent.length <= limit * EVIDENCE_ROW_OVERFETCH;

  const exchanges: SessionEvidenceExchange[] = [];
  let hitTurnLimit = false;
  for (const row of recent) {
    if (exchanges.length >= limit) {
      hitTurnLimit = true;
      break;
    }
    const at = row.timestamp.getTime();
    const agentText = readAgentText(row.envelope);
    if (agentText) {
      exchanges.push({ speaker: 'agent', text: agentText, at });
      continue;
    }
    const personText = readPersonText(row.envelope);
    if (personText) exchanges.push({ speaker: 'person', text: personText, at });
  }
  exchanges.reverse();

  return { openingRequest, exchanges, complete: sawEveryRow && !hitTurnLimit };
}

function readMetadata(envelope: unknown): Record<string, unknown> | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const metadata = (envelope as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  return metadata as Record<string, unknown>;
}

/** Whatever a person said in this event — a start, a resume, or a room post. */
function readPersonText(envelope: unknown): string | null {
  const metadata = readMetadata(envelope);
  if (!metadata) return null;
  const userMessage = metadata['userMessage'];
  if (typeof userMessage === 'string' && userMessage.trim().length > 0) return userMessage;
  const room = RoomMessageMetadataSchema.safeParse(metadata);
  if (room.success && room.data.body.trim().length > 0) return room.data.body;
  return null;
}

/**
 * The agent's committed answer.
 *
 * `agentResponse` on the pause is where a root conversation's reply actually
 * lives — `agentMessage` rides only the events forwarded to a PARENT session,
 * so reading that alone showed the human's side of every ordinary chat and
 * nothing else. The summaries produced from it said "no answer appears in the
 * record", which was an honest report of a broken envelope.
 */
function readAgentText(envelope: unknown): string | null {
  const metadata = readMetadata(envelope);
  if (!metadata) return null;
  for (const key of ['agentResponse', 'agentMessage']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}
