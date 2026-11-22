import { DESK_LENSES, LENS_NAMES, type DeskLens } from './strategyDeskAggregate.js';

/**
 * The six lenses that review a successor draft. The desk's principles lens
 * reviews candidate theses against the folder's principles. The boundary
 * judges the draft against the ending contract's own rules, and the
 * performance review checks every correction against the principles.
 */
export type BoundaryLens = Exclude<DeskLens, 'principles'>;
export const BOUNDARY_LENSES = DESK_LENSES.filter(
  (lens): lens is BoundaryLens => lens !== 'principles',
);

/** What the boundary ledger read gathers. It decides nothing and forms no view. */
export const BOUNDARY_READ_LEDGER_PROMPT = `Gather what the strategist reads before it drafts the successor of a Daily Trading Cycle campaign. Copy facts from memory into your output. Form no view, and propose nothing.

Inputs (already in your task context):
- \`campaign\` — the active campaign contract, whose window is ending.

Read, newest first:
- Resolved theses: every doc under \`/portfolio/theses/resolved/\` whose regimeName is the campaign's, at most 200. Copy each doc's thesisId, hypothesisId, instrument, direction, outcome, entryFillState, statedConfidence, resolvedTradingDay and lenses.
- Open theses: every doc under \`/portfolio/theses/open/\`. Copy each doc's thesisId, hypothesisId, instrument, direction and sizePct.
- The arm table: the most recent \`/portfolio/snapshots/*-after_close.json\` doc. Copy its armTable, or null.
- Lens records: the 60 most recent docs under \`/research/*/lens-reviews/\`. Copy each doc's tradingDay, slotKey, round and lenses.
- Journal: the 20 most recent docs under \`/research/journal/\`. Copy each doc's tradingDay, from its name, and its text.

Every item carries the memory \`path\` it was read from. Copy values as they stand. Never compute, round or summarise a number. Where a read fails or finds nothing, leave its list empty and say so in \`ledgerNote\`.`;

/** The strategist's boundary brief: it drafts the successor's contract as data. */
export const BOUNDARY_STRATEGIST_TASK = `You are the strategist of a paper-trading desk at a campaign boundary. The campaign in \`campaign\` is ending. Draft the contract of the campaign that succeeds it. Six review lenses review your draft after you, and nothing you draft starts a campaign: the draft is data, and the boundary applies it only once every lens approves.

This checkout is the space's folder. Change no file in it.

Read first, before you form any view:
- The journals, strategy records and boundary rules in this folder.
- \`ledger\` — the campaign as memory holds it: its resolved and open theses, the arm table, the lens records of every desk review, and the journal.
- \`goals\` — what the Daily Trading Cycle is measured on, and \`campaign\` — the ending contract with its boundary rules: pooledSampleFloor, expectancyFloorR and calibrationRule.

Then write your result:
- \`successor\` — the successor's complete contract, every field the campaign contract declares. Its regimeName names a new regime. Carry an arm forward only where the boundary rules say it earned it, and say so in \`arms\`.
- \`arms\` — one entry per arm of the ending campaign: carry, revise or drop, with the reason, quoting the ledger's numbers against the boundary rules.
- \`rationale\` — why this contract, quoting every number you used.
- \`memo\` — the boundary memo, in Markdown.`;

/** Each lens's question on a successor draft. */
export const CAMPAIGN_LENS_QUESTIONS: Record<BoundaryLens, string> = {
  fundamentals:
    'Fundamentals: does the universe hold instruments whose businesses can carry the hypotheses the draft tests?',
  macro:
    'Macro: do the hypotheses and the caps fit the rates, the dollar and the index regime the journal describes?',
  technical:
    'Technical: are the hypotheses price-checkable, and do the horizon bounds fit the setups the resolved theses show?',
  priorLearnings:
    'Prior learnings: does the draft answer what the resolved theses and the journal taught about each arm?',
  priorDecisions:
    'Prior decisions: does the draft follow the boundary rules of the ending campaign, carrying only arms that earned it?',
  risk: 'Risk: do the caps, the arm budgets and the gross exposure bound the losses the ending campaign took?',
};

/** One lens's brief on a successor draft, in the shape a focused review takes. */
export function campaignLensTask(lens: BoundaryLens): string {
  return `You are the ${LENS_NAMES[lens]} reviewer of a paper-trading desk at a campaign boundary. The strategist has drafted the contract of the successor campaign, in \`draft\`. Six lenses review it, each in a run of its own, and yours is one of them.

\`focus\` names your lens: ${CAMPAIGN_LENS_QUESTIONS[lens]} Judge the draft through it, against the ending contract in \`campaign\`. Leave the other lenses to their own runs.

This checkout is the space's folder. Change no file in it. Your inputs hold only what your lens needs.

Give the draft one verdict, with the reason your lens gives:
- \`approved\` — your lens finds nothing against the boundary applying it.
- \`revise\` — the boundary may apply it once the strategist answers your reason.
- \`rejected\` — your lens vetoes it. One lens rejection rejects the draft, whatever the other lenses say.`;
}
