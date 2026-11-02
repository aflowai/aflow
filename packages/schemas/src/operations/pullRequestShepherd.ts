/**
 * What the Local PR Shepherd reads off a pull request, and the records it
 * writes there (Plan 321).
 *
 * Every value here is read by two sides — Local Publish writing a pull
 * request and a forge's provider shaping its answers for the shepherd, or
 * the shepherd writing its handoff and reading it back on its next pass — so
 * each is written once. What the shepherd reads a pull request as is the
 * forge vocabulary's (`forge/vocabulary.ts`), and GitHub's answers are shaped
 * by GitHub's provider (Plan 340).
 */

/**
 * Closes the body of every pull request Local Publish writes. A pull request
 * whose body carries it was opened by the loop; one without it is a person's,
 * and the shepherd leaves it alone.
 */
export const LOCAL_PUBLISH_PULL_REQUEST_MARKER = '<!-- aflow:local-publish -->';

/** The label a person puts on a pull request the shepherd is to leave alone. */
export const SHEPHERD_HANDS_OFF_LABEL = 'hands-off';

/** How many failures of one pull request the shepherd acts on before it stops. */
export const SHEPHERD_ATTEMPT_BUDGET_DEFAULT = 3;

/** Where the shepherd's leases live in the space's memory: `<root>/<owner>/<repo>/<branch>/`. */
export const SHEPHERD_LEASE_ROOT = '/shepherd';
export const SHEPHERD_LEASE_DOCUMENT = 'lease.json';

/**
 * Where a pull request's handoff is pinned — `<root>/<owner>/<repo>/pulls/<number>.json`,
 * per pull request, never per branch, since a branch can carry a second pull
 * request after the first closes. It holds the comment's id and the login the
 * comment was posted as, both read off GitHub's answer to the pass that wrote
 * it: the comment is read by its id wherever it sits in a long conversation,
 * and its record is trusted only from that author. Beside them it keeps the
 * attempt state that comment recorded — `attemptCount` and `checkRunId` — so
 * where the comment is deleted the record's budget and its guard survive it.
 */
export const SHEPHERD_HANDOFF_PINS = 'pulls';

/**
 * Where a merge's outcome is recorded — `<root>/<owner>/<repo>/pulls/<number>/merges/<headSha>.json`,
 * one document per head. It is written under the branch's lease, before the
 * lease is released, and read under the lease before a merge is asked for:
 * any pass that holds the lease after one recorded an outcome for a head
 * finds it, so no two passes ask to merge the same head, however they overlap.
 */
export const SHEPHERD_MERGE_OUTCOME_DOCS = 'merges';

/**
 * Where a pull request handed to a person is claimed — `<root>/<owner>/<repo>/pulls/<number>/abandons/<headSha>.json`,
 * one document per head, created and never overwritten. A pass that decides
 * `abandon` raises its Action Center item only where its own create of the
 * head's claim succeeded, so however many passes find the budget spent on one
 * head, and however they overlap, one item is raised for it; a push that
 * moves the head is a new head.
 */
export const SHEPHERD_ABANDON_DOCS = 'abandons';

/**
 * Where a case handed to the agent is claimed, one document per case,
 * created and never overwritten, so a case is handed over once however many
 * passes find it. A pull request's case is its head and what the pass ended
 * on — `<root>/<owner>/<repo>/pulls/<number>/handovers/<headSha>/<case>.json`,
 * beside its pinned handoff — so a push that moves the head is a new case, and
 * so is another case on the same head. A case of the repository itself, read
 * before any pull request is, is the turn —
 * `<root>/<owner>/<repo>/handovers/<turn's content hash>/<case>.json` — so it
 * stays one case until a pass lists the repository's pull requests again.
 */
export const SHEPHERD_HAND_OVER_DOCS = 'handovers';

/** The agent a case the shepherd's rules cannot act on is handed to: the space's Helmsman. */
export const SHEPHERD_HAND_OVER_TARGET = {
  kind: 'platform-role',
  systemRole: 'cybernetic-helmsman',
} as const;

/**
 * `<root>/<owner>/<repo>/turn.json`: the pull request the last pass aimed at
 * none tended. The next such pass tends the one after it, so passes on a
 * schedule take the loop's pull requests in turn, whatever the forge's
 * last-updated order does when a handoff is written.
 */
export const SHEPHERD_TURN_DOCUMENT = 'turn.json';

/** The Local PR Shepherd's slug: its agent's and its workflow's alike. */
export const SHEPHERD_SLUG = 'local-pr-shepherd';

/**
 * How often the shepherd's schedule fires unless the operator names another
 * interval: hourly. The schedule is the fallback sweep of Plan 339 D4. A pull
 * request's owner runs a pass on the pull request's own events, so the sweep
 * serves only the pull requests no conversation holds.
 */
export const SHEPHERD_SCHEDULE_CRON_DEFAULT = '0 * * * *';

/**
 * The interval {@link SHEPHERD_SCHEDULE_CRON_DEFAULT} names. A waiter whose
 * window closes inside it is woken before the next sweep, so the sweep passes
 * its pull request over (Plan 339 D5).
 */
export const SHEPHERD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A lease older than this is stale whatever its run says: a pass that holds
 * one longer — a commission's two hours and a publication waiting at its
 * approval besides — has stopped, and the next pass takes the lease over.
 */
export const SHEPHERD_LEASE_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * How long GitHub must have refused to list a repository's open pull requests,
 * on every pass since the first that could not, before the case is handed to
 * the agent: the second failing pass at the default interval. One failed listing is read
 * again by the next pass, and a conversation started on it would be one that
 * pass made unnecessary.
 */
export const SHEPHERD_UNLISTED_PERSISTS_AFTER_MS = 15 * 60 * 1000;

/**
 * The handoff comment opens with this and carries its record as `key: value`
 * lines up to {@link SHEPHERD_HANDOFF_CLOSE}, so the record is invisible on
 * the pull request and the text after it is what a person reads.
 */
export const SHEPHERD_HANDOFF_OPEN = '<!-- aflow:shepherd';
export const SHEPHERD_HANDOFF_CLOSE = '-->';

export const SHEPHERD_HANDOFF_FIELDS = [
  'attemptCount',
  'checkRunId',
  'headSha',
  'decision',
  'classification',
  'remedy',
  'publicationRunId',
  'mergeDeclinedSha',
  'mergeRefusedSha',
  'mergeCommitSha',
] as const;
export type ShepherdHandoffField = (typeof SHEPHERD_HANDOFF_FIELDS)[number];

/**
 * The three ways a merge the shepherd asked for ends — the operator declined
 * the card, GitHub refused the request pinned to the head, or GitHub merged
 * it — each the decision of the rule step that reads it, and the handoff field
 * that records it. A template has no condition, so the handoff writes this
 * pass's outcome as one line, `mergeOutcome: <outcome> <sha>`, and
 * {@link parseShepherdHandoff} files the sha under the outcome's field.
 */
export const SHEPHERD_MERGE_OUTCOMES = {
  merge_declined: 'mergeDeclinedSha',
  merge_refused: 'mergeRefusedSha',
  merged: 'mergeCommitSha',
} as const satisfies Record<string, ShepherdHandoffField>;
export type ShepherdMergeOutcome = keyof typeof SHEPHERD_MERGE_OUTCOMES;
export const SHEPHERD_MERGE_OUTCOME_FIELDS = Object.values(SHEPHERD_MERGE_OUTCOMES);

/** The handoff line that carries this pass's merge outcome; not itself a field of the record. */
export const SHEPHERD_MERGE_OUTCOME_LINE = 'mergeOutcome';

export interface ShepherdHandoffRecord {
  /** Failures acted on so far. */
  attemptCount: number;
  /** The check run the last action answered; the same one again is not acted on. */
  checkRunId?: string;
  headSha?: string;
  decision?: string;
  /** What the remedy question answered, which the routes turn into the remedy taken. */
  classification?: string;
  /** The remedy the pass took: what its brief and the next classification read as the round before. */
  remedy?: string;
  publicationRunId?: string;
  /** A head whose merge the operator declined: no later pass asks again on it. */
  mergeDeclinedSha?: string;
  /** A head GitHub refused to merge on the shepherd's request: no later pass asks again on it. */
  mergeRefusedSha?: string;
  /** The commit GitHub's squash merge made, where the shepherd's merge went through. */
  mergeCommitSha?: string;
}

/**
 * The record a handoff comment's body carries, or null where the body is not
 * a handoff. A field written empty, or a count that is not a whole number, is
 * read as absent: the next pass then acts as on a first failure rather than
 * refusing to read the pull request at all. A merge outcome on the
 * {@link SHEPHERD_MERGE_OUTCOME_LINE} line stands over the same field carried
 * forward from an earlier pass.
 */
export function parseShepherdHandoff(body: string): ShepherdHandoffRecord | null {
  const text = body.trimStart();
  if (!text.startsWith(SHEPHERD_HANDOFF_OPEN)) return null;
  const end = text.indexOf(SHEPHERD_HANDOFF_CLOSE, SHEPHERD_HANDOFF_OPEN.length);
  const block = text.slice(SHEPHERD_HANDOFF_OPEN.length, end === -1 ? undefined : end);
  const values = new Map<string, string>();
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value !== '') values.set(key, value);
  }
  const count = values.get('attemptCount');
  const record: ShepherdHandoffRecord = {
    attemptCount: count !== undefined && /^\d{1,6}$/.test(count) ? Number(count) : 0,
  };
  for (const field of SHEPHERD_HANDOFF_FIELDS) {
    if (field === 'attemptCount') continue;
    const value = values.get(field);
    if (value !== undefined) record[field] = value;
  }
  const outcome = /^([a-z_]+) (\S+)$/.exec(values.get(SHEPHERD_MERGE_OUTCOME_LINE) ?? '');
  if (outcome !== null && Object.hasOwn(SHEPHERD_MERGE_OUTCOMES, outcome[1]!)) {
    record[SHEPHERD_MERGE_OUTCOMES[outcome[1] as ShepherdMergeOutcome]] = outcome[2]!;
  }
  return record;
}
