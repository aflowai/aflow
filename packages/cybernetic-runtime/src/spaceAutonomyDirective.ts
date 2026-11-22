/**
 * The operator's directive for a raise to `full` (Plan 345 D), read from the
 * space's conversation record rather than from anything a session writes.
 *
 * The record is the event log of the space's conversations. The API stamps
 * the author of two of its event types from the authenticated request: a
 * `SessionResumed` carrying the message that resumed a conversation, and a
 * `RoomMessage` posted for the Helmsman. No agent session writes either with
 * an author, so either one attests that a person sent the words. Every other
 * record holding words is refused, each with the reason.
 *
 * The quote must be the whole of one message, and that message must ask for
 * the raise: it names `full` and `autonomy` as whole words, and no word of it
 * negates or reverses (`directiveAsk`). A quote that is part of a longer
 * message is refused, so no fragment of a message stands for the operator's ask.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { createTenantContext, eventLog, sessions, withTenantSchema } from '@aflow/database';
import {
  ROOM_MESSAGE_MAX_LENGTH,
  RoomMessageMetadataSchema,
  WAIT_OUTCOME_ACTOR_ID,
  type SpaceAutonomyDirective,
  type SpaceAutonomyDirectiveRecordType,
  type TenantId,
} from '@aflow/schemas';

/** How many messages of the space's conversation record a raise reads, newest first. */
export const SPACE_AUTONOMY_DIRECTIVE_RECORDS_READ = 200;

/** One event of the space's conversation record that holds words. */
export interface SpaceAutonomyDirectiveRecordRow {
  eventId: string;
  sessionId: string;
  eventType: string;
  timestamp: Date;
  envelope: unknown;
  /** Set where an agent session started this conversation. */
  parentSessionId: string | null;
}

/** A verified directive, before the raise spends it. */
export type VerifiedSpaceAutonomyDirective = Omit<SpaceAutonomyDirective, 'spentAt'>;

export type SpaceAutonomyDirectiveFinding =
  | { kind: 'verified'; directive: VerifiedSpaceAutonomyDirective }
  | { kind: 'not_found' }
  | { kind: 'names_no_raise' }
  | { kind: 'refuses_raise'; word: string }
  | { kind: 'partial_quote'; sessionId: string; eventId: string }
  | { kind: 'agent_authored'; sessionId: string; eventId: string; reason: string }
  | { kind: 'unattested'; sessionId: string; eventId: string; reason: string }
  | { kind: 'not_operator'; sessionId: string; eventId: string; authorUserId: string }
  | { kind: 'spent'; sessionId: string; eventId: string; spent: SpaceAutonomyDirective };

type Refusal = Extract<
  SpaceAutonomyDirectiveFinding,
  { kind: 'agent_authored' | 'unattested' | 'not_operator' | 'spent' }
>;

type Classified =
  | {
      kind: 'attested';
      eventType: SpaceAutonomyDirectiveRecordType;
      authorUserId: string;
      words: string;
    }
  | { kind: 'agent_authored' | 'unattested'; words: string; reason: string };

/**
 * The newest messages of the space's conversation record: room messages, and
 * the opening or resuming events that carry a message.
 */
export async function readSpaceAutonomyDirectiveRecords(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<SpaceAutonomyDirectiveRecordRow[]> {
  return withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) =>
    tx
      .select({
        eventId: eventLog.eventId,
        sessionId: eventLog.sessionId,
        eventType: eventLog.eventType,
        timestamp: eventLog.timestamp,
        envelope: eventLog.envelope,
        parentSessionId: sessions.parentSessionId,
      })
      .from(eventLog)
      .innerJoin(sessions, eq(sessions.sessionId, eventLog.sessionId))
      .where(
        and(
          eq(sessions.spaceId, spaceId),
          or(
            eq(eventLog.eventType, 'RoomMessage'),
            and(
              inArray(eventLog.eventType, ['SessionStarted', 'SessionResumed']),
              isNotNull(sql`${eventLog.envelope} #>> '{metadata,userMessage}'`),
            ),
          ),
        ),
      )
      .orderBy(desc(eventLog.timestamp))
      .limit(SPACE_AUTONOMY_DIRECTIVE_RECORDS_READ),
  );
}

/** Words as a quote is compared with them: case, spacing and typographic quotes set aside. */
export function normalizeDirectiveWords(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words that negate or reverse a raise. A message holding any of them as a
 * whole word does not ask for `full`, whatever else it says: "please do not
 * set full autonomy" refuses, and "full autonomy, not ratify" is read the
 * same way. The rule errs toward refusing. A refused ask costs the operator
 * one more message, and a granted refusal lifts every gate at once.
 */
export const DIRECTIVE_NEGATING_WORDS: ReadonlySet<string> = new Set([
  'no',
  'not',
  'never',
  'nor',
  'neither',
  'none',
  'without',
  'cannot',
  'dont',
  'doesnt',
  'didnt',
  'wont',
  'cant',
  'shouldnt',
  'wouldnt',
  'mustnt',
  'isnt',
  'arent',
  'stop',
  'cancel',
  'revoke',
  'refuse',
  'deny',
  'disable',
  'remove',
  'revert',
  'undo',
  'lower',
  'drop',
  'off',
  'ratify',
]);

/** The whole words of normalised text: runs of letters, digits and apostrophes. */
function directiveWordsOf(normalized: string): string[] {
  return normalized.match(/[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * Whether a message's whole content asks for the raise to `full`. It asks
 * where it names `full` and `autonomy` as whole words and holds no negating
 * word: one of `DIRECTIVE_NEGATING_WORDS`, apostrophes set aside, or any word
 * ending in `n't`.
 */
export function directiveAsk(
  text: string,
): { kind: 'asks' } | { kind: 'names_no_raise' } | { kind: 'refuses_raise'; word: string } {
  const words = directiveWordsOf(normalizeDirectiveWords(text));
  if (!words.includes('full') || !words.includes('autonomy')) return { kind: 'names_no_raise' };
  const negating = words.find(
    (word) => word.endsWith("n't") || DIRECTIVE_NEGATING_WORDS.has(word.replace(/'/g, '')),
  );
  return negating === undefined ? { kind: 'asks' } : { kind: 'refuses_raise', word: negating };
}

function metadataOf(envelope: unknown): Record<string, unknown> | undefined {
  if (envelope === null || typeof envelope !== 'object') return undefined;
  const metadata = (envelope as { metadata?: unknown }).metadata;
  return metadata !== null && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>)
    : undefined;
}

/** Who wrote a record's words, as far as the record attests it. Undefined where it holds none. */
function classifyDirectiveRecord(row: SpaceAutonomyDirectiveRecordRow): Classified | undefined {
  const metadata = metadataOf(row.envelope);
  if (metadata === undefined) return undefined;

  if (row.eventType === 'RoomMessage') {
    const parsed = RoomMessageMetadataSchema.safeParse(metadata);
    if (!parsed.success) return undefined;
    const { actorUserId, body, wakeHelmsman } = parsed.data;
    if (actorUserId === WAIT_OUTCOME_ACTOR_ID) {
      return {
        kind: 'unattested',
        words: body,
        reason: "it is the platform's notice of a wait's outcome, which no person wrote",
      };
    }
    if (!wakeHelmsman) {
      return {
        kind: 'unattested',
        words: body,
        reason:
          'it is a room line not sent to the Helmsman, as the platform posts for a join or an applet action',
      };
    }
    return { kind: 'attested', eventType: 'RoomMessage', authorUserId: actorUserId, words: body };
  }

  const words = metadata['userMessage'];
  if (typeof words !== 'string' || words.trim() === '') return undefined;
  const actorUserId = metadata['actorUserId'];

  if (row.eventType === 'SessionStarted') {
    if (row.parentSessionId !== null) {
      return {
        kind: 'agent_authored',
        words,
        reason: 'it opens a session an agent session started, so an agent wrote it',
      };
    }
    return {
      kind: 'unattested',
      words,
      reason:
        "a conversation's opening message carries whoever started the conversation, a person, a schedule or an agent session alike",
    };
  }

  if (row.eventType !== 'SessionResumed') return undefined;
  if (typeof actorUserId !== 'string' || actorUserId === '') {
    return {
      kind: 'agent_authored',
      words,
      reason:
        'it resumed the conversation with no author stamped, as an agent session or a schedule resumes one',
    };
  }
  if (actorUserId === WAIT_OUTCOME_ACTOR_ID) {
    return { kind: 'unattested', words, reason: 'its author is the platform, not a person' };
  }
  return { kind: 'attested', eventType: 'SessionResumed', authorUserId: actorUserId, words };
}

/**
 * The newest message of the space's conversation record whose whole words
 * equal `quote`, verified: the quote asks for the raise (`directiveAsk`), the
 * platform stamped a person as its author, that person is an operator of the
 * space, and no earlier raise spent it or a later one. Equality is of the
 * whole message after normalisation, never a substring. Where no equal
 * message passes, the newest equal message's refusal. Where no message is
 * equal but one holds the quote as a part, `partial_quote`.
 */
export async function selectSpaceAutonomyDirective(args: {
  rows: readonly SpaceAutonomyDirectiveRecordRow[];
  quote: string;
  spent: SpaceAutonomyDirective | undefined;
  isOperator: (userId: string) => Promise<boolean>;
}): Promise<SpaceAutonomyDirectiveFinding> {
  const quote = normalizeDirectiveWords(args.quote);
  if (quote === '') return { kind: 'not_found' };
  // The quote must equal the message whole, so the quote's words are the message's.
  const ask = directiveAsk(quote);
  if (ask.kind !== 'asks') return ask;
  const spentAtMs = args.spent === undefined ? undefined : Date.parse(args.spent.postedAt);
  let refusal: Refusal | undefined;
  const refuse = (next: Refusal) => {
    refusal ??= next;
  };

  let partial: { kind: 'partial_quote'; sessionId: string; eventId: string } | undefined;

  const rows = [...args.rows].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  for (const row of rows) {
    const record = classifyDirectiveRecord(row);
    if (record === undefined) continue;
    const words = normalizeDirectiveWords(record.words);
    const at = { sessionId: row.sessionId, eventId: row.eventId };
    if (words !== quote) {
      if (words.includes(quote)) partial ??= { kind: 'partial_quote', ...at };
      continue;
    }
    if (record.kind !== 'attested') {
      refuse({ kind: record.kind, ...at, reason: record.reason });
      continue;
    }
    if (
      args.spent !== undefined &&
      (row.eventId === args.spent.eventId ||
        (spentAtMs !== undefined && row.timestamp.getTime() <= spentAtMs))
    ) {
      refuse({ kind: 'spent', ...at, spent: args.spent });
      continue;
    }
    if (!(await args.isOperator(record.authorUserId))) {
      refuse({ kind: 'not_operator', ...at, authorUserId: record.authorUserId });
      continue;
    }
    return {
      kind: 'verified',
      directive: {
        ...at,
        eventType: record.eventType,
        authorUserId: record.authorUserId,
        postedAt: row.timestamp.toISOString(),
        words: record.words.slice(0, ROOM_MESSAGE_MAX_LENGTH),
      },
    };
  }
  return refusal ?? partial ?? { kind: 'not_found' };
}
