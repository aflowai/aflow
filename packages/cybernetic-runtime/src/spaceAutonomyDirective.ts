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
 * the raise: an imperative addressed to the agent with full autonomy as its
 * object, holding no negation, no question and no condition (`directiveAsk`).
 * A quote that is part of a longer message is refused, so no fragment of a
 * message stands for the operator's ask.
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
  | Exclude<DirectiveAsk, { kind: 'asks' }>
  | { kind: 'partial_quote'; sessionId: string; eventId: string }
  | { kind: 'agent_authored'; sessionId: string; eventId: string; reason: string }
  | { kind: 'unattested'; sessionId: string; eventId: string; reason: string }
  | { kind: 'not_operator'; sessionId: string; eventId: string; authorUserId: string }
  | {
      kind: 'before_lowering';
      sessionId: string;
      eventId: string;
      postedAt: string;
      loweredAt: string;
    }
  | { kind: 'spent'; sessionId: string; eventId: string; spent: SpaceAutonomyDirective };

type Refusal = Extract<
  SpaceAutonomyDirectiveFinding,
  { kind: 'agent_authored' | 'unattested' | 'not_operator' | 'before_lowering' | 'spent' }
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

/** Words that name the raise beside `autonomy`: the level the operator asks for. */
export const DIRECTIVE_RAISE_WORDS: ReadonlySet<string> = new Set([
  'full',
  'absolute',
  'complete',
  'total',
]);

/**
 * Verbs that open an imperative addressed to the agent. A clause that opens
 * with one of them and names the raise directs it.
 */
export const DIRECTIVE_IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  'set',
  'give',
  'grant',
  'switch',
  'raise',
  'turn',
  'make',
  'put',
  'move',
  'change',
  'enable',
  'go',
  'take',
  'flip',
  'bump',
  'allow',
  'apply',
  'use',
]);

/** Words a clause may open with before its verb, as "please set" or "ok, now set" do. */
const DIRECTIVE_LEADING_WORDS: ReadonlySet<string> = new Set([
  'please',
  'pls',
  'kindly',
  'now',
  'just',
  'ok',
  'okay',
  'yes',
  'so',
  'and',
  'then',
]);

/**
 * Words that open a question: an interrogative, or an auxiliary placed first
 * as in "should I give you full autonomy". A clause that opens with one of
 * them asks the operator's question, not the agent's task.
 */
export const DIRECTIVE_QUESTION_WORDS: ReadonlySet<string> = new Set([
  'what',
  'why',
  'how',
  'where',
  'who',
  'whom',
  'whose',
  'which',
  'whether',
  'should',
  'shall',
  'can',
  'could',
  'would',
  'will',
  'may',
  'might',
  'must',
  'do',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'am',
  'has',
  'have',
  'had',
]);

/** Words that hang a message's ask on a condition, as "if CI passes, set full autonomy" does. */
export const DIRECTIVE_CONDITION_WORDS: ReadonlySet<string> = new Set([
  'if',
  'unless',
  'when',
  'whenever',
  'once',
  'until',
  'till',
  'after',
  'provided',
  'providing',
  'assuming',
  'suppose',
  'supposing',
  'otherwise',
]);

/** What `directiveAsk` finds in a message: an ask, or the step that refuses it. */
export type DirectiveAsk =
  | { kind: 'asks' }
  | { kind: 'names_no_raise' }
  | { kind: 'refuses_raise'; word: string }
  | { kind: 'question' }
  | { kind: 'conditional'; word: string }
  | { kind: 'ambiguous' };

/** The whole words of normalised text: runs of letters, digits and apostrophes. */
function directiveWordsOf(normalized: string): string[] {
  return normalized.match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** The clauses of normalised text, each as its words. Punctuation and dashes end a clause. */
function directiveClausesOf(normalized: string): string[][] {
  return normalized
    .split(/[.,;:!?…()"\-–—]+/u)
    .map(directiveWordsOf)
    .filter((words) => words.length > 0);
}

function namesRaise(words: readonly string[]): boolean {
  return words.includes('autonomy') && words.some((word) => DIRECTIVE_RAISE_WORDS.has(word));
}

/** A clause's words after the courtesies and connectives it opens with. */
function withoutLeadingWords(clause: readonly string[]): readonly string[] {
  let start = 0;
  while (start < clause.length && DIRECTIVE_LEADING_WORDS.has(clause[start]!)) start += 1;
  return clause.slice(start);
}

/**
 * Whether a clause directs the raise. It names the raise and opens with an
 * imperative verb, as "please set full autonomy" does. Or it is the raise
 * alone with "please", as "absolute autonomy please" and "the full autonomy, please" are.
 */
function clauseDirectsRaise(
  clause: readonly string[],
  index: number,
  clauses: ReadonlyArray<readonly string[]>,
): boolean {
  if (!namesRaise(clause)) return false;
  const verb = withoutLeadingWords(clause)[0];
  if (verb !== undefined && DIRECTIVE_IMPERATIVE_VERBS.has(verb)) return true;
  // "please" may stand in the clause, or as a clause of its own beside it.
  const isPlease = (words: readonly string[] | undefined) =>
    words?.length === 1 && words[0] === 'please';
  const pleased =
    clause.includes('please') || isPlease(clauses[index - 1]) || isPlease(clauses[index + 1]);
  if (!pleased) return false;
  const rest = clause.filter((word) => word !== 'please' && word !== 'the' && word !== 'now');
  return rest.length === 2 && DIRECTIVE_RAISE_WORDS.has(rest[0]!) && rest[1] === 'autonomy';
}

/**
 * Whether a message's whole content asks for the raise to `full`: an
 * imperative addressed to the agent with full autonomy as its object. The
 * rule runs five steps in order, and the first that fails refuses the message:
 *
 * 1. It names the raise: `autonomy` and one of `DIRECTIVE_RAISE_WORDS`, as whole words.
 * 2. It holds no negating word: one of `DIRECTIVE_NEGATING_WORDS`, apostrophes
 *    set aside, or any word ending in `n't`.
 * 3. It asks no question: it holds no question mark and no `whether`, and no
 *    clause opens with one of `DIRECTIVE_QUESTION_WORDS`.
 * 4. It sets no condition: it holds none of `DIRECTIVE_CONDITION_WORDS`.
 * 5. It directs the raise: a clause names the raise and opens with one of
 *    `DIRECTIVE_IMPERATIVE_VERBS`, or the clause is the raise alone with "please".
 *
 * The rule errs toward refusing. A refused ask costs the operator one more
 * message, and a granted question lifts every gate at once.
 */
export function directiveAsk(text: string): DirectiveAsk {
  const normalized = normalizeDirectiveWords(text);
  const words = directiveWordsOf(normalized);
  if (!namesRaise(words)) return { kind: 'names_no_raise' };
  const negating = words.find(
    (word) => word.endsWith("n't") || DIRECTIVE_NEGATING_WORDS.has(word.replace(/'/g, '')),
  );
  if (negating !== undefined) return { kind: 'refuses_raise', word: negating };
  const clauses = directiveClausesOf(normalized);
  const asksQuestion =
    normalized.includes('?') ||
    words.includes('whether') ||
    clauses.some((clause) => {
      const opening = withoutLeadingWords(clause)[0];
      return opening !== undefined && DIRECTIVE_QUESTION_WORDS.has(opening);
    });
  if (asksQuestion) return { kind: 'question' };
  const condition = words.find((word) => DIRECTIVE_CONDITION_WORDS.has(word));
  if (condition !== undefined) return { kind: 'conditional', word: condition };
  return clauses.some((clause, index) => clauseDirectsRaise(clause, index, clauses))
    ? { kind: 'asks' }
    : { kind: 'ambiguous' };
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
 * space, it was posted after the space's last lowering, and no earlier raise
 * spent it or a later one. A space never lowered has never been full, so
 * every message of its record, all posted after its creation, may qualify.
 * Equality is of the whole message after normalisation, never a substring.
 * Where no equal message passes, the newest equal message's refusal. Where no
 * message is equal but one holds the quote as a part, `partial_quote`.
 */
export async function selectSpaceAutonomyDirective(args: {
  rows: readonly SpaceAutonomyDirectiveRecordRow[];
  quote: string;
  spent: SpaceAutonomyDirective | undefined;
  /** When the space's autonomy last changed from `full` to `ratify`. */
  loweredAt: string | undefined;
  isOperator: (userId: string) => Promise<boolean>;
}): Promise<SpaceAutonomyDirectiveFinding> {
  const quote = normalizeDirectiveWords(args.quote);
  if (quote === '') return { kind: 'not_found' };
  // The quote must equal the message whole, so the quote's words are the message's.
  const ask = directiveAsk(quote);
  if (ask.kind !== 'asks') return ask;
  const loweredAtMs = args.loweredAt === undefined ? undefined : Date.parse(args.loweredAt);
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
    // Checked before the spend: a message from before the lowering never raises, spent or not.
    if (
      args.loweredAt !== undefined &&
      loweredAtMs !== undefined &&
      row.timestamp.getTime() <= loweredAtMs
    ) {
      refuse({
        kind: 'before_lowering',
        ...at,
        postedAt: row.timestamp.toISOString(),
        loweredAt: args.loweredAt,
      });
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
