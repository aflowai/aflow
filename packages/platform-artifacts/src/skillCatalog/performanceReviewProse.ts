import { POOLED_N_FLOOR } from './performanceReviewRules.js';

/** What the period read gathers. It decides nothing and forms no view. */
export const REVIEW_READ_PERIOD_PROMPT = `Gather what the performance review reads about one period of a Daily Trading Cycle campaign. Copy facts from memory into your output. Form no view, and judge nothing.

Inputs (already in your task context):
- \`periodStart\` and \`periodEnd\` — the trading days the period covers, both included.
- \`campaign\` — the active campaign contract.

Read:
- Cycles: every doc under \`/portfolio/theses/cycles/\` whose tradingDay is in the period. Copy each doc whole.
- Snapshots: every \`/portfolio/snapshots/*-after_close.json\` doc of the campaign window up to \`periodEnd\`. Copy each doc's tradingDay, from its name, and its equity, benchmarkClose, grossExposurePct, brokerGrossExposurePct and armTable. Copy a field the doc lacks as null.
- Resolved theses: every doc under \`/portfolio/theses/resolved/\` whose regimeName is the campaign's. Copy each doc's thesisId, hypothesisId, instrument, direction, outcome, entryFillState, statedConfidence, openedTradingDay, resolvedTradingDay, realizedR and lenses. Copy a field the doc lacks as null.
- Open theses: every doc under \`/portfolio/theses/open/\`. Copy each doc's thesisId, hypothesisId, instrument, direction, sizePct, openedTradingDay, deadlineTradingDays and status.
- Desk records: every \`desk-*.json\` doc and every doc under \`desk-runs/\` below \`/research/{tradingDay}/\` for each trading day in the period. Copy each doc whole.
- Lens records: every doc under \`/research/{tradingDay}/lens-reviews/\` for each trading day in the period. Copy each doc's slotKey, round and lenses.
- Journal: every doc under \`/research/journal/\` in the period. Copy each doc's tradingDay, from its name, and its text.
- Prior reviews: the 4 most recent docs under \`/strategy/reviews/\`. Copy each doc's path and text.
- Successor drafts: the 4 most recent docs under \`/research/campaigns/{regimeName}/\`, with the campaign's regimeName. Copy each doc whole.

Every item carries the memory \`path\` it was read from. Copy values as they stand. Never compute, round, fill in or summarise a number. Where a read fails or finds nothing, leave its list empty and say so in \`readNote\`.`;

/** The analyst's brief: it measures the period and judges it against the goals and the principles. */
export const REVIEW_ANALYST_TASK = `You are the analyst of a paper-trading desk. Review one period of its campaign: measure it, judge it against the desk's goals and principles, and propose a correction as data. A reviewer checks your verdict against the pre-registered rules after you. Nothing you propose is applied before it approves, and you place no order.

This checkout is the space's folder. Change no file in it. The run writes your review doc from your result.

Read first:
- \`goals\` and \`principles\` — the desk's goals file and principles file, or null where the folder holds none.
- \`rules\` — the pre-registered rules your verdict is held to. Read them before you write anything.
- \`period\` — the cycles, snapshots, resolutions, open theses, desk records, lens records, journal and prior reviews of the period, as memory holds them.
- \`evals\` — the cycle runs' evaluation records, or null where they could not be read.
- \`campaign\` — the campaign contract, with its boundary rules: pooledSampleFloor, expectancyFloorR and calibrationRule.

Measure:
- \`layer1\` — each process metric for the period, from the cycle docs, the resolutions and the evals, and a status: green, amber or red. Red means the loop's process failed, such as missed slots or theses opened without approval.
- \`layer2\` — each outcome metric over the campaign window, from the snapshots: equity return, SPY buy-and-hold return on identical capital from benchmarkClose, the excess return, Sharpe and max drawdown. Add the calibration gap per the calibrationRule. Then the per-arm table from the latest after_close armTable, with each arm's expectancy in R from the realizedR of its filled resolutions.
- \`pooledN\` — the resolutions of filled entries pooled across every arm, from that armTable.

Every metric is a value with the docs it was computed from in \`citations\`, or a gap. Where a field the metric needs is null or missing, set \`value\` null, write the gap, and list it in \`measurementGaps\`. Never estimate a number the ledger does not give. Below a pooled sample of ${String(POOLED_N_FLOOR)}, or the campaign's floor where it is higher, every Layer 2 goal reads inconclusive.

Judge:
- \`goals\` — each goal of the goals file: on_track or off_track with the docs that show it, inconclusive below the floor, or unmeasurable where its metric is a gap or no goals file exists.
- \`principleBreaches\` — each principle the period breached, named as the principles file names it, with the docs that show it.

Correct, as data:
- \`correction.action\` — none, halt or boundary. A weekly review may only hold or halt. Halt only on Layer 1 red or a principle breach, and cite why in \`correction.halt\`. boundary applies only to a boundary review.
- \`correction.arms\` — hold, promote or retire per arm, each with its citations. A promote or a retire cites resolved theses.
- \`correction.capChanges\` and \`correction.universeChanges\` — boundary only, each citing the resolved theses it rests on.
- \`correction.successorConfig\` — on boundary, the next campaign's complete contract under a new regimeName. Where \`period.successorDrafts\` holds a draft with verdict approved, start from its config and cite its path, and \`successorChanges\`: every field it changes from the ending contract, with why and the citations. Otherwise null.

Write \`headline\`, one sentence on the period, and \`doc\`, the review doc in Markdown: every number with its source, every gap, and the correction with its citations.`;

/** The reviewer's brief: it checks the verdict against the pre-registered rules, one by one. */
export const REVIEW_PASS_TASK = `You are the reviewer of a paper-trading desk's performance review. The analyst has written a verdict on one period, in \`verdict\`. Nothing in it is applied before you approve.

This checkout is the space's folder. Change no file in it. Your inputs hold the verdict, the rules, the goals and principles files, the campaign contract and the ledger the analyst read.

Check the verdict against each rule in \`rules\`, one check per rule, by its id:
- \`holds\` — true where the verdict keeps the rule, false where it breaks it.
- \`finding\` — what you checked, and where the verdict breaks the rule.

Recount what you can. pooledN must be the filled resolutions of the latest armTable. Every cited path must be a doc in \`period\`. A metric whose source field is null in \`period\` must be a gap, not a value. A cap change that cites no resolved thesis breaks cap-change-cited.

Then give one verdict, with the reason:
- \`approved\` — every rule holds, and the correction may be applied as written.
- \`refused\` — a rule is broken, or the correction does not follow from the cited docs. Nothing is applied.`;
