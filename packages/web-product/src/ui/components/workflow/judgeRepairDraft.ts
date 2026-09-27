/**
 * The message an operator hands Helmsman when a judge keeps getting trials
 * wrong — composed from the verdicts they recorded against it, so the request
 * arrives with its evidence rather than as an assertion.
 */

export interface JudgeDisagreement {
  runId: string;
  /** What the operator recorded. */
  verdict: string;
  /** What the judge returned; absent on an older label. */
  judgeLabel: string | null;
  critique: string;
}

/**
 * A browser and the servers between it cap a URL well below the megabytes a
 * label set could reach, and the draft rides one as a query parameter. Quoting
 * whole critiques up to this much and reporting the remainder keeps every
 * quoted word intact.
 *
 * Percent-encoding can roughly triple a character, so the budget is the
 * ENCODED length, measured rather than assumed.
 */
const DRAFT_BUDGET_CHARS = 6000;

/** What the draft actually costs the URL it travels in. */
function encodedLength(text: string): number {
  return encodeURIComponent(text).length;
}

/** The remainder sentence, empty when everything was quoted. */
function omittedSentence(omitted: number, quoted: number): string {
  if (omitted <= 0) return '';
  const subject = `${String(omitted)} ${omitted === 1 ? 'disagreement is' : 'disagreements are'}`;
  return `${
    quoted === 0
      ? `${subject} recorded against this criterion. None are quoted here — they are longer than a link can carry; read them on the criterion's calibration tab.`
      : `${String(omitted)} further ${omitted === 1 ? 'disagreement is' : 'disagreements are'} recorded against this criterion, not quoted here.`
  }\n`;
}

export function buildJudgeRepairDraft(params: {
  criterionName: string;
  criterionId: string;
  evalSuitePath: string;
  scopeKey: string;
  disagreements: readonly JudgeDisagreement[];
  /**
   * How many labels the disagreements were drawn from, against how many exist.
   * The endpoint caps its sample page, so beyond that cap the disagreements
   * here are a prefix — and a draft that counted them as the whole set would
   * state a number nobody measured.
   */
  sampledFrom?: { read: number; total: number };
}): string {
  const { criterionName, criterionId, evalSuitePath, scopeKey, disagreements } = params;
  const truncated =
    params.sampledFrom !== undefined && params.sampledFrom.total > params.sampledFrom.read;

  const head = [
    `The judge for "${criterionName}" is deciding trials differently from me.`,
    '',
    `Criterion: ${criterionId} (${scopeKey})`,
    `Suite: ${evalSuitePath}`,
    '',
  ].join('\n');

  const partialNote = truncated
    ? `These come from the ${String(params.sampledFrom?.read ?? 0)} most recent of ${String(params.sampledFrom?.total ?? 0)} labels on this criterion; earlier ones were not read.\n\n`
    : '';

  const tail = [
    '',
    'Read the criterion as written, work out what is making it land differently from my',
    'reading, and propose a revision. If the criterion is right and those answers really',
    'were wrong, say so instead of changing it.',
  ].join('\n');

  // The remainder sentence is part of the draft, so it is reserved before any
  // entry is quoted — its longest form, since the count only shrinks as more
  // are quoted. Budgeting the entries and appending it afterwards is how the
  // draft ends up over the ceiling it just measured itself against.
  const remainderReserve = encodedLength(omittedSentence(disagreements.length, 0));

  const entries: string[] = [];
  let used =
    encodedLength(head) + encodedLength(tail) + encodedLength(partialNote) + remainderReserve;
  let quoted = 0;

  for (const item of disagreements) {
    const entry = [
      `Run ${item.runId} — the judge returned ${item.judgeLabel ?? 'no recorded verdict'}, I recorded ${item.verdict}.`,
      `  ${item.critique}`,
      '',
    ].join('\n');
    const cost = encodedLength(entry);
    // No exemption for the first entry. One critique can legitimately run to
    // thousands of characters, and quoting it anyway produced a URL past the
    // ceiling this budget exists to hold — a link that fails on navigation,
    // which is worse than a draft that says what it left out.
    if (used + cost > DRAFT_BUDGET_CHARS) break;
    entries.push(entry);
    used += cost;
    quoted += 1;
  }

  const omittedLine = omittedSentence(disagreements.length - quoted, quoted);

  return `${head}${entries.join('')}${omittedLine}${partialNote}${tail}`;
}
