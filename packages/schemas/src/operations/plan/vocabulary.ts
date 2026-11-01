import type { PlanBoardColumn, PlanNeedsYouReason } from './schemas.js';

/**
 * The one vocabulary of a plan step's state (Plan 338 D5). The board, the
 * overview, the Action Center item's title and the Workbench all read their
 * words from here, so a label changed here changes on every surface at once.
 * Labels name a state. The verbs on the controls (Approve, Decide, Drop,
 * Reopen, Close done) are actions and are not in this table.
 */
export const PLAN_STATE_LABELS = {
  /** A board column, and the overview lane of the same id. */
  column: {
    needs_you: 'Pending',
    in_flight: 'Running',
    up_next: 'Queued',
    done: 'Done',
    dropped: 'Dropped',
  } satisfies Record<PlanBoardColumn, string>,
  /** Why a step stands in the `needs_you` column. */
  reason: {
    blocked: 'Approval',
    decide: 'Decision',
    stranded: 'Under a closed step',
  } satisfies Record<PlanNeedsYouReason, string>,
  /** A plan whose step stands in the `needs_you` column. */
  planNeedsYou: 'Pending approval',
  /** What follows the count of `needs_you` steps in a plan's header: "3 pending". */
  pendingCountNoun: 'pending',
  /** The `needs_you` lane with no step in it. */
  pendingEmpty: 'Nothing pending',
  /** What a plan step's Action Center item is titled before the step's own title. */
  itemTitle: {
    blocked: 'Pending approval',
    merge_wait: 'Pending review',
    decide: 'Pending decision',
  },
  /** The Workbench section that holds approvals, inputs and connections. */
  workbenchSection: 'Pending',
} as const;

/** What a plan step's Action Center item waits on: an approval of a blocked step, a merge to judge, or a decision. */
export type PlanItemWait = keyof (typeof PLAN_STATE_LABELS)['itemTitle'];

/** The most characters an Action Center item's title holds. */
const PLAN_ITEM_TITLE_MAX_CHARS = 256;

/** What ends a title or summary cut to fit, so the reader sees that it goes on. */
const PLAN_ITEM_CUT_MARK = '…';

/**
 * A plan step's Action Center item title: "Pending approval · <title>", at
 * most `PLAN_ITEM_TITLE_MAX_CHARS`. The client renders it as inline markdown,
 * so a title too long to fit is cut before the syntax that would stand open
 * at the cut, never inside it, and ends with an ellipsis.
 */
export function planItemTitle(wait: PlanItemWait, title: string): string {
  const head = `${PLAN_STATE_LABELS.itemTitle[wait]} · `;
  if (head.length + title.length <= PLAN_ITEM_TITLE_MAX_CHARS) return `${head}${title}`;
  const budget = PLAN_ITEM_TITLE_MAX_CHARS - head.length - PLAN_ITEM_CUT_MARK.length;
  return `${head}${inlineMarkdownCut(title, budget).trimEnd()}${PLAN_ITEM_CUT_MARK}`;
}

const MARKDOWN_ESCAPABLE = /[!-/:-@[-`{-~]/;
const EMPHASIS_CHARS = new Set(['*', '_', '~']);
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The longest prefix of inline markdown, at most `budget` characters, that
 * ends where no construct stands open: outside a code span, a link's text
 * and destination, an autolink, a backslash escape and every emphasis run.
 * It errs toward cutting early. A literal `*` the scan reads as an opener
 * moves the cut back before it, which costs words and never shows markup.
 */
function inlineMarkdownCut(text: string, budget: number): string {
  let safe = 0;
  let codeRun = 0;
  let brackets = 0;
  let destination = 0;
  let angle = false;
  const emphasis: string[] = [];
  let i = 0;
  while (i < text.length && i <= budget) {
    if (codeRun === 0 && brackets === 0 && destination === 0 && !angle && emphasis.length === 0)
      safe = i;
    const ch = text[i]!;
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      if (codeRun === 0) codeRun = run;
      else if (run === codeRun) codeRun = 0;
      i += run;
      continue;
    }
    if (codeRun > 0) {
      i++;
      continue;
    }
    if (ch === '\\' && MARKDOWN_ESCAPABLE.test(text[i + 1] ?? '')) {
      i += 2;
      continue;
    }
    if (angle) {
      if (ch === '>') angle = false;
      i++;
      continue;
    }
    if (destination > 0) {
      if (ch === '(') destination++;
      else if (ch === ')') destination--;
      i++;
      continue;
    }
    if (ch === '<' && /[A-Za-z/!?]/.test(text[i + 1] ?? '')) {
      angle = true;
    } else if (ch === '[') {
      brackets++;
    } else if (ch === ']' && brackets > 0) {
      brackets--;
      if (text[i + 1] === '(') {
        destination = 1;
        i += 2;
        continue;
      }
    } else if (EMPHASIS_CHARS.has(ch)) {
      let run = 1;
      while (text[i + run] === ch) run++;
      const before = text[i - 1];
      const after = text[i + run];
      const leftFlanking = after !== undefined && /\S/.test(after);
      const rightFlanking = before !== undefined && /\S/.test(before);
      // An underscore inside a word is a letter, not emphasis.
      const canOpen =
        leftFlanking && (ch !== '_' || before === undefined || !WORD_CHAR.test(before));
      const canClose =
        rightFlanking && (ch !== '_' || after === undefined || !WORD_CHAR.test(after));
      const opener = emphasis.lastIndexOf(ch);
      if (canClose && opener >= 0) emphasis.length = opener;
      else if (canOpen) emphasis.push(ch);
      i += run;
      continue;
    }
    i++;
  }
  if (
    i <= budget &&
    codeRun === 0 &&
    brackets === 0 &&
    destination === 0 &&
    !angle &&
    emphasis.length === 0
  )
    safe = i;
  // A cut between the halves of a surrogate pair would leave half a character.
  if (safe > 0 && /[\uD800-\uDBFF]/.test(text[safe - 1]!)) safe--;
  return text.slice(0, Math.min(safe, budget));
}

/** The most blocked and merge-wait nodes the space's Action Center lists at once, newest first. */
export const PLAN_OPEN_ASKS_LIMIT = 50;
/** The most open `decide` nodes the space's Action Center lists at once. */
export const PLAN_OPEN_DECISIONS_LIMIT = 50;
/**
 * The most items the space's Action Center list route returns by default,
 * across every source. It cuts the combined list after the per-source limits.
 */
export const ACTION_CENTER_LIST_LIMIT = 200;

/** The count of plan steps that wait on a person, as the sidebar and the Helmsman both show it. */
export interface PlanPendingCount {
  /** Waiting nodes and open decisions together. */
  count: number;
  /**
   * Whether either set holds as many as its source lists at most, or the list
   * it was read from may have cut. It says the count may have cut, not that it has.
   */
  mayBeCut: boolean;
  /** "3", or "50+" where the count may have cut. */
  label: string;
}

/**
 * The plan-step count from its two sets: the waiting nodes (`plan_ask`) and
 * the open decisions (`plan_decision`), each as long as its source lists. The
 * sidebar reads the sets off the Action Center list, and the Helmsman's block
 * off the plan walk, so one tree reads the same on both (Plan 338 D1, D2).
 */
export function pendingPlanStepCount(sets: {
  asks: number;
  decisions: number;
  listMayBeCut?: boolean;
}): PlanPendingCount {
  const count = sets.asks + sets.decisions;
  const mayBeCut =
    sets.asks >= PLAN_OPEN_ASKS_LIMIT ||
    sets.decisions >= PLAN_OPEN_DECISIONS_LIMIT ||
    sets.listMayBeCut === true;
  return { count, mayBeCut, label: mayBeCut ? `${String(count)}+` : String(count) };
}

/** The most characters an Action Center item's summary holds. */
const PLAN_ITEM_SUMMARY_MAX_CHARS = 2_000;

/** A fence line: up to three spaces, then three or more backticks or tildes. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The fence a markdown text leaves open at its end, as the line that closes it; undefined where none is open. */
function openFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const [, run = '', rest = ''] = match;
    if (open === undefined) {
      // A backtick fence's info string holds no backtick.
      if (run.startsWith('~') || !rest.includes('`')) open = run;
    } else if (run.startsWith(open.charAt(0)) && run.length >= open.length && rest.trim() === '') {
      open = undefined;
    }
  }
  return open;
}

/**
 * Where the last block of a markdown text with no fence open begins: past the
 * last blank line or fence line. Inline markdown does not cross either.
 */
function lastBlockStart(text: string): number {
  let start = 0;
  let offset = 0;
  const lines = text.split('\n');
  for (const line of lines.slice(0, -1)) {
    offset += line.length + 1;
    if (line.trim() === '' || FENCE_LINE.test(line)) start = offset;
  }
  return start;
}

/**
 * A plan item's markdown text as its summary, at most
 * `PLAN_ITEM_SUMMARY_MAX_CHARS`. A text too long to fit ends with the
 * ellipsis a cut title ends with. The client renders it as block markdown,
 * so a cut inside a fenced code block closes the fence and puts the ellipsis
 * on the line after it. Otherwise the rest of the card would render as code.
 * A cut in prose falls before any inline construct it would leave open, as a
 * title's does.
 */
export function planItemSummary(text: string): string {
  if (text.length <= PLAN_ITEM_SUMMARY_MAX_CHARS) return text;
  // One character more than the mark: the mark may need a line of its own.
  let budget = PLAN_ITEM_SUMMARY_MAX_CHARS - PLAN_ITEM_CUT_MARK.length - 1;
  for (;;) {
    let cut = text.slice(0, budget);
    // A cut between the halves of a surrogate pair would leave half a character.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    const fence = openFence(cut);
    if (fence === undefined) {
      const start = lastBlockStart(cut);
      const tail = cut.slice(start);
      const kept = `${cut.slice(0, start)}${inlineMarkdownCut(tail, tail.length)}`.trimEnd();
      // A fence's closing line holds nothing after its run, so the mark goes below it.
      const lastLine = kept.slice(kept.lastIndexOf('\n') + 1);
      return FENCE_LINE.test(lastLine)
        ? `${kept}\n${PLAN_ITEM_CUT_MARK}`
        : `${kept}${PLAN_ITEM_CUT_MARK}`;
    }
    const closed = `${cut}${cut.endsWith('\n') ? '' : '\n'}${fence}\n${PLAN_ITEM_CUT_MARK}`;
    if (closed.length <= PLAN_ITEM_SUMMARY_MAX_CHARS) return closed;
    budget -= closed.length - PLAN_ITEM_SUMMARY_MAX_CHARS;
  }
}
