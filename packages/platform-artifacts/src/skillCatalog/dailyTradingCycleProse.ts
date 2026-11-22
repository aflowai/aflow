import { APPROVED_THESES_PATH_TEMPLATE } from './dailyTradingCycleApproved.js';
import { INTRADAY_INDEX_RULE } from './dailyTradingCycleSlots.js';

export const DAILY_CYCLE_RESOLVE_THESES_PROMPT = `Anchor this cycle to a (tradingDay, slot) identity, then resolve every open thesis whose written criteria have an answer in the observed price data.

Inputs (already in your task context):
- \`requestedSlot\`, \`requestedSlotIndex\` — the slot the schedule fired for, and its intraday firing number. Either may be absent.
- \`requestedTradingDay\` — the day a Strategy Desk started this cycle for. Absent on a schedule.
- \`maxThesesPerDay\` — the campaign's cap on new theses per trading day, across all its slots.
- \`clockTimestamp\`, \`marketIsOpen\`, \`nextOpen\`, \`nextClose\` — the exchange clock. The timestamp is exchange-local, and its date part is the exchange date.
- \`equity\` — account equity (USD).
- \`positions\` — live open positions, the truth of what is held.
- \`openOrders\` — orders still open at the broker.

The thesis ledger lives in memory:
- Open theses: one JSON doc per thesis under \`/portfolio/theses/open/\`.
- Resolved theses: \`/portfolio/theses/resolved/\`.
- Deferred intentions: \`/portfolio/intentions/\` — orders awaiting submission by an open-market cycle.
- Completed cycles: \`/portfolio/theses/cycles/{tradingDay}-{slotKey}.json\` — a cycle doc exists exactly when that cycle completed. \`{slotKey}\` is the slot, or \`intraday-{slotIndex}\` on an intraday cycle.
- Market-data cache: \`/portfolio/market-data/{symbol}.json\` — recent daily bars (shape in /portfolio/theses/SCHEMA.md).

Step 1 — the cycle identity. The slot is \`requestedSlot\` when given, and \`slotIndex\` is \`requestedSlotIndex\`. An intraday slot with no index takes ${INTRADAY_INDEX_RULE}. With no \`requestedSlot\`, derive the slot from the clock:
- Market open, no \`open\` cycle doc for the clock date → \`open\`. With one → \`intraday\`.
- Market closed, \`nextOpen\` later on the clock date → \`pre_market\`.
- Market closed otherwise → \`after_close\`. On a weekend or holiday its cycle usually exists already, so the trigger is a duplicate no-op.

\`tradingDay\` is the clock date for pre_market, open and intraday. For after_close it is the most recent COMPLETED session, confirmed from the latest daily bar of a liquid index ETF (e.g. SPY). A slot with no session behind it → \`proceed: false\` with the reason: pre_market or open on a day with no session, open or intraday on a closed market, after_close on an open one. A \`requestedTradingDay\` other than \`tradingDay\` → \`proceed: false\`, its \`noopReason\` naming both days.

Step 2 — idempotency: read the cycle doc for \`(tradingDay, slotKey)\`. If it already exists, this trigger is a duplicate — set \`proceed: false\`, \`noopReason\` naming the existing cycle doc, output empty \`resolutions\`, fill the cap fields as Step 2b says, and stop.

Step 2b — the day's cap: copy \`maxThesesPerDay\` into your output. List every cycle doc of \`tradingDay\` and collect the distinct thesisIds their \`thesesOpened\` name into \`thesesOpenedToday\`. Set \`remainingThesesToday\` = \`maxThesesPerDay\` less that count, floored at 0. On after_close it is 0, because after_close opens nothing. The contract refuses any other value.

Step 3 — resolve, FILL TRUTH FIRST. List every doc under \`/portfolio/theses/open/\` and evaluate EVERY open thesis — not just those due today. A thesis written before a missed slot still gets resolved now; that is what makes a missed slot lose nothing.

For each open thesis, establish the fill truth of its entry BEFORE reading any price criterion — a thesis criterion measures a trade, and without a fill there was no trade:
- Entry recorded as submitted → look its order up by broker order id (your order-status tool). When the record carries NO broker order id (a duplicate-rejected resubmission, or a lost write), the order may still EXIST at the broker under its deterministic client order id — list orders for that symbol (your orders-list tool: symbols={instrument}, status=all, limit=500) and match the client order id before concluding anything; only a search that finds no such order means the entry was never submitted. \`filled\` or \`partially_filled\` = the thesis is LIVE; resolve it on criteria below. \`expired\`, \`canceled\`, \`rejected\`, or \`done_for_day\` unfilled = resolve \`entry_failed\`. Still open and unfilled at the broker = the thesis is not live yet; leave it in \`openThesesAfter\` unless the deadline has passed, in which case resolve \`entry_failed\`.
- Entry recorded as a deferred intention (\`status: "entry_pending"\`) → still pending within its deadline stays in \`openThesesAfter\`; past its deadline resolves \`entry_failed\` (the intention will be expired, never submitted).
- Entry recorded as failed → resolve \`entry_failed\`.

An \`entry_failed\` resolution states the order facts in \`evidence\` (status, expiry, rejection message). You may note how the prediction would have fared, but attribute NO P&L and narrate NO position — no position ever existed, and "position remains held" about a non-fill is a false ledger entry. Set \`closePosition: false\`, \`closeQty: null\`.

Every resolution asserts its entry's fill truth explicitly in \`entryFillState\`: \`filled\` or \`partial\` as read from the broker for a live thesis, \`none\` for \`entry_failed\`. A criteria outcome (confirmed / falsified / expired) with \`entryFillState: "none"\` is a contradiction — the assertion exists so it can be cross-checked against broker data.

Only a LIVE thesis (filled or partially filled entry) resolves on its written criteria:
- Fetch the observed prices its criteria name (current snapshot, daily bars since entry — whatever the written criterion requires). Daily-bar history is cache-first: read \`/portfolio/market-data/{symbol}.json\`, fetch from your market-data tools only the days the cache lacks, then upsert the doc keeping the most recent 30 daily bars. Only COMPLETED sessions enter the cache: while the market is open, today's bar is still forming — read it fresh when a criterion needs it, never upsert it. The cache and a fresh fetch are the ONLY price sources — never mine price history from thesis rationales or other prose in the ledger.
- \`falsified\` when the written falsification criterion is met in the observed data. When falsification and confirmation both read as met, falsified wins — resolve conservatively.
- \`confirmed\` when the written confirmation criterion is met and falsification is not.
- \`expired\` when neither has triggered and the number of completed trading sessions since entry (count the instrument's daily bars after the entry date) has reached \`deadlineTradingDays\`.
- \`tactical_exit\` — open and intraday slots only — when neither criterion has triggered but the current price gives a reason to close the position now. State that reason with its numbers in \`evidence\`.
- Otherwise the thesis stays open — list its id in \`openThesesAfter\`.

Your output contract holds what each slot may resolve. pre_market sees no price of the session, so it leaves repair closes and orphans for the open. On open and intraday, a criterion naming a daily close cannot be met before the close.

Every resolution's \`evidence\` must quote the observed numbers against the written criterion (e.g. "close 187.20 < stop level 189.00 stated in the falsification criterion"). Resolve ONLY on observed data. If the data a criterion needs is unavailable this cycle, leave the thesis open and say which data was missing in \`coverageNote\` — an unresolvable criterion is a fact to record, not a license to guess.

For each resolution of a live thesis (confirmed, falsified, expired or tactical_exit), set \`closePosition: true\` when the account actually holds a position in that instrument (check \`positions\`), and \`closeQty\` to the THESIS's own filled entry quantity as a POSITIVE string, clamped to the currently held quantity — the broker reports a short position as negative qty, and the symbol's aggregate position may serve several theses: closing the aggregate for one thesis over-closes and flips.

Step 4 — pending intentions: list \`/portfolio/intentions/\`. Report every intention that will still submit — entry intentions within their thesis deadline, plus all close intentions — in \`pendingIntentions\` (thesisId, intent, symbol, qty, notional from each doc). These are queued orders an open-market cycle submits once due (an entry waits for its entry condition). The decide task folds them into its exposure projection.

Step 5 — orphan detection and close repair: compare \`positions\` against the instruments of the open theses AND of pending close intentions — a held position whose resolved thesis is awaiting a deferred close is accounted for, not an orphan. A held position whose thesis is ALREADY RESOLVED with closePosition true but whose resolved doc shows no filled close is an UNCLOSED RESOLUTION, not an orphan: first RE-READ its original close order by broker order id (a stale 'pending' record must not mint a repair — the close may have filled since); only when the close is genuinely unfilled, list it in \`repairCloses\` (thesisId, instrument, qty = the THESIS's own filled entry quantity clamped to the currently held quantity) so this cycle's execution closes it — without this, one failed close strands the position forever. Any broker position that neither the open set, pending closes, nor repairCloses accounts for is an ORPHAN. This account is the agent's alone to manage, so every orphan is the agent's to RECONCILE, never to leave standing. Record its provenance from order history for the honest ledger (your orders-list tool: symbols={symbol}, status=all, limit=500 — name the creating order's client id, or say "provenance undetermined"), then list it in \`orphanFlattens\` (symbol, absolute held qty, side as held, evidence) for this cycle's execution to flatten back to a clean state where every position carries a thesis. You cannot honestly write a falsifiable thesis for a position that already exists — so reconciliation is a flat close, not an after-the-fact adoption.

Step 6 — coverage honesty: \`coverageNote\` names every (tradingDay, slotKey) between the last recorded cycle doc and this one that has no cycle doc — a missed slot is recorded, never papered over. If nothing was missed, say so. The expected grid is the SCHEDULED slots of each trading day: pre_market, open, after_close, and the intraday indices below the highest one recorded that day. Never report a slot outside that grid as missed.

Output (submit_output):
{
  tradingDay: string,          // YYYY-MM-DD
  slot: "pre_market" | "open" | "intraday" | "after_close",
  slotIndex: number | null,    // null outside intraday
  proceed: boolean,            // false = duplicate cycle or non-trading day; downstream tasks skip
  noopReason: string | null,
  maxThesesPerDay: number,
  thesesOpenedToday: string[],
  remainingThesesToday: number,
  resolutions: [
    {
      thesisId: string,
      instrument: string,
      direction: "long" | "short",
      outcome: "confirmed" | "falsified" | "expired" | "entry_failed" | "tactical_exit",
      entryFillState: "filled" | "partial" | "none",   // broker-read fill truth; criteria outcomes require filled/partial
      evidence: string,                  // observed numbers vs the written criterion; order facts for entry_failed
      statedConfidence: "low" | "medium" | "high",   // copied from the thesis doc
      closePosition: boolean,
      closeQty: string | null            // absolute held quantity when closePosition is true (never negative)
    }
  ],
  openThesesAfter: string[],   // thesisIds still open after this pass
  pendingIntentions: [ { thesisId: string, intent: "open" | "close", symbol: string, qty: string | null, notional: string | null } ],
  repairCloses: [ { thesisId: string, instrument: string, qty: string } ],   // resolved-but-unclosed positions this cycle must close
  orphanFlattens: [ { symbol: string, qty: string, side: "long" | "short", evidence: string } ],   // every position with no thesis — the agent owns the account, so it reconciles (flattens) all of them
  coverageNote: string
}`;

export const DAILY_CYCLE_DECIDE_PROMPT = `Open this cycle's new theses from its approved set under the campaign's frozen regime, each one written to be falsifiable before any order exists.

The approved set — \`${APPROVED_THESES_PATH_TEMPLATE}\`, read it first:
- Its \`slots\` maps each \`{slotKey}\` to the entries a review has passed on. \`{slotKey}\` is the slot, or \`intraday-{slotIndex}\` on an intraday cycle.
- Each entry carries \`approvedId\`, \`instrument\`, \`direction\`, \`entryLevel\`, \`invalidationLevel\`, \`confirmationLevel\`, \`maxSizePct\`, \`horizonTradingDays\`, \`reviewerVerdict\` and \`reviewRunId\`. It may carry \`hypothesisId\`, and \`lenses\`: what each review lens said on it.
- Only an entry under this cycle's slotKey with \`reviewerVerdict: "approved"\` may become a thesis.
- No document, or no approved entry for this slotKey, makes this a resolve-only cycle. Submit \`theses: []\` and say so in \`decisionRationale\`.
- Your output contract reads the set at submission. It refuses a thesis whose \`approvedId\` the set does not approve, and one that departs from its entry.
- Only the operator, or a completed review run outside this cycle, may write the set. You hold no memory write, so you cannot change it.
- When the contract reports the set cannot be read, does not parse, or comes from a refused writer, the set approves nothing. Submit \`theses: []\` and copy the fault sentence it quotes into \`approvedSetFault\`. The cycle still resolves, closes and records, and the cycle doc shows the fault to the operator.
- Otherwise \`approvedSetFault\` is null.

Inputs (already in your task context):
- \`tradingDay\`, \`slot\`, \`slotIndex\` — this cycle's identity. Copy all three into your output: they are pinned. The slot decides what you may form:
  - \`pre_market\` forms the day's theses before any price of the session exists. Every one carries an \`entryCondition\` and waits as a deferred intention until an open-market cycle reads it as met.
  - \`open\` and \`intraday\` may form new theses under the day's remaining cap. An \`entryCondition\` is optional there: null enters at once.
  - \`after_close\` forms none.
- \`thesesOpenedToday\`, \`remainingThesesToday\` — the theses earlier slots of this trading day opened, and how many more the day allows. \`remainingThesesToday\` bounds your \`theses\` array.
- \`resolutions\` — theses resolved this cycle; today's freshest evidence about the regime.
- \`openThesesAfter\` — thesisIds still open. A live one already carries exposure in \`positions\`; an entry-pending one carries FUTURE exposure through its pending intention.
- \`pendingIntentions\` — deferred orders queued for the next open-market submission: pending entries ADD exposure, pending closes REMOVE it.
- \`repairCloses\` — resolved-but-unclosed positions this cycle's execution closes: their notionals REMOVE exposure exactly like this cycle's closes.
- \`orphanFlattens\` — orphan positions being flattened this cycle (the agent manages the whole account) — excluded from campaign exposure arithmetic, they are being cleared.
- \`equity\` — account equity; \`positions\` — live positions.
- \`regimeName\`, \`hypotheses\` — the campaign and the frozen hypotheses it tests side by side, one arm each: \`id\`, \`name\`, \`statement\`, \`thesisBudgetPerDay\`. Every thesis you propose is an instance of one of them and cites its \`id\` in \`hypothesisId\`. An arm may open at most its \`thesisBudgetPerDay\` theses in one trading day, earlier slots included, and your output contract counts that from the ledger. Do not improvise a different strategy mid-campaign. If a hypothesis looks wrong, say so in \`decisionRationale\` and propose fewer or zero theses for its arm. The regime changes at campaign boundaries, not here.
- \`universe\`, \`maxThesesPerDay\`, \`maxPositionSizePct\`, \`maxGrossExposurePct\`, \`minHorizonTradingDays\`, \`maxHorizonTradingDays\` — the campaign caps. Your output contract enforces them; a violation is returned to you as a validation error naming the field — fix the named field and resubmit, do not work around it.
- Prior learnings from past cycles — auto-injected. Read them; they cite resolved theses.

Evidence discipline for this campaign: theses cite price structure only — per-instrument OHLCV (your bar and snapshot data) plus index/regime context that is itself price data (e.g. SPY/QQQ trend). No news, no narratives, no fundamentals. Each criterion must be price-checkable: a later cycle must be able to read prices and decide yes/no without interpretation.

Steps:
1. Read the regime context: recent daily bars for the index ETFs and for candidate universe instruments. Bars are cache-first: read \`/portfolio/market-data/{symbol}.json\`, then fetch from your market-data tools only the days the cache lacks. You read the cache and never write it: resolution keeps it. Today's bar is still forming on an open or intraday cycle, so cite fresh intraday data when needed. Ground every claim in numbers you actually fetched.
2. Propose 0 to \`remainingThesesToday\` theses, each one an instance of one approved entry. Zero is a legitimate answer when the setup is absent — say why in \`decisionRationale\`. For each thesis:
   - \`thesisId\`: unique kebab-case, e.g. "2026-07-14-aapl-1".
   - \`hypothesisId\`: the arm this thesis tests, the one its approved entry names. It must be one of the \`hypotheses\` ids.
   - \`approvedId\`, \`reviewRunId\` and \`lenses\`: copied verbatim from its approved entry, \`lenses\` null where the entry carries none. One entry opens one thesis.
   - \`instrument\` and \`direction\`: the entry's own, which the universe must also hold.
   - The criteria and the entry condition: written from the entry's \`entryLevel\`, \`invalidationLevel\` and \`confirmationLevel\`.
   - \`rationale\`: the observed setup, with the numbers (e.g. "closed above the 20-day high of 187.40 on 1.8x average volume").
   - \`entryCondition\`: the price condition that makes the entry due (e.g. "trades above 187.40 after the open"), or null to enter at the next open-market submission.
   - \`falsificationCriterion\`: the price condition that proves this thesis wrong (e.g. "a daily close below 184.00").
   - \`confirmationCriterion\`: the price condition that proves it right (e.g. "a daily close above 195.00").
   - \`deadlineTradingDays\`: sessions until the thesis expires unresolved, within the campaign horizon bounds and at most the entry's \`horizonTradingDays\`.
   - \`sizePct\`: percent of equity for the entry, within the per-position cap and at most the entry's \`maxSizePct\`. A SHORT entry submits as whole shares rounded down from sizePct / 100 × equity — an instrument whose share price exceeds that notional sizes to zero and fails, so size shorts for at least one share.
   - \`confidence\`: your honest prior — it is scored against the resolution later, so calibrate, do not posture.
3. Avoid duplicating exposure: instruments already carrying an open thesis need a distinctly different setup to justify a second one.
4. \`projectedGrossExposurePct\`: the thesis-attributed gross after everything queued lands — start from the absolute notionals of \`positions\`, exclude \`orphanFlattens\` (being cleared this cycle), subtract this cycle's closes, the pending close intentions, AND the repairCloses notionals (look each up in \`positions\`), add the pending entry intentions and your proposed entries; divide by equity, times 100. Compute it from the numbers — the cap on this field is the campaign's gross-exposure limit, and pending intentions count toward it: deferral must not smuggle exposure past the cap.

Output (submit_output):
{
  tradingDay: string,          // copied from your input
  regimeName: string,          // copied from your input
  slot: "pre_market" | "open" | "intraday" | "after_close",   // copied from your input
  slotIndex: number | null,    // copied from your input
  approvedSetFault: string | null,   // the fault the contract quotes for a bad set, else null
  theses: [
    {
      thesisId: string,
      hypothesisId: string,      // the campaign hypothesis id its approved entry names
      approvedId: string,        // the approved entry this thesis instantiates
      reviewRunId: string,       // copied from that entry
      lenses: object | null,     // copied verbatim from that entry
      instrument: string,
      direction: "long" | "short",
      rationale: string,
      entryCondition: string | null,   // required on pre_market
      falsificationCriterion: string,
      confirmationCriterion: string,
      deadlineTradingDays: number,
      sizePct: number,
      confidence: "low" | "medium" | "high"
    }
  ],
  projectedGrossExposurePct: number,
  decisionRationale: string     // why these theses (or why none), grounded in the observed data
}`;

export const DAILY_CYCLE_EXECUTE_ORDERS_PROMPT = `Place exactly the orders your inputs specify — closes from this cycle's resolutions, entries from this cycle's theses, plus any deferred intentions left by earlier cycles that are now due. You have zero discretion over what to trade; your job is faithful, idempotent, clock-gated execution and honest reporting.

Inputs (already in your task context):
- \`tradingDay\`, \`slot\`, \`slotIndex\` — this cycle's identity. \`{slotKey}\` below is the slot, or \`intraday-{slotIndex}\` on an intraday cycle. Copy \`slot\` into your output: it is pinned, and your output contract holds what the slot allows.
  - \`pre_market\` submits NOTHING, whatever the clock says. It writes each thesis entry as a deferred intention carrying its entry condition.
  - \`open\` and \`intraday\` submit due intentions and this cycle's orders.
  - \`after_close\` opens nothing. Its closes defer as intentions while the market is closed.
- \`marketIsOpen\` — the ingested exchange clock. THE submission gate: orders queued against a closed market never fill on this account.
- \`resolutions\` — close the position for every entry with \`closePosition: true\`, using its \`closeQty\`.
- \`repairCloses\` — positions whose theses resolved in an EARLIER cycle but whose closes never filled: close each at its absolute qty, client order id "{tradingDay}-{slotKey}-{thesisId}-close" (this cycle's identity makes the id fresh).
- \`orphanFlattens\` — every orphan position (this account is the agent's alone; resolution reconciles all of them): flatten each FIRST, before all other orders — market, day, side opposite the held side, qty verbatim, client order id "{tradingDay}-{slotKey}-orphan-{symbol}-flatten", thesisId "orphan:{symbol}" in the order result. This is the ONE exception to no-order-without-a-thesis: reconciling an unmanaged position back to a clean, fully-thesis-covered account is the account owner's duty, and resolution's provenance record is the pre-registered evidence behind it.
- \`theses\` — submit one entry order per thesis, sized from \`sizePct\`. A thesis whose \`entryCondition\` is not met at submission time defers as an intention instead. Every thesis carries the \`approvedId\` of the reviewed entry it instantiates. Copy it onto the entry's order result and its intention doc. A close carries \`approvedId: null\`.
- \`equity\` — account equity for entry sizing.

Rule 0 — the clock and the slot gate every submission. Submit orders ONLY when \`marketIsOpen\` is true and the slot is not \`pre_market\`. Otherwise submit NOTHING: write each proposed order (closes and entries alike) as a deferred intention doc at \`/portfolio/intentions/{clientOrderId}.json\` — clientOrderId, thesisId, approvedId (null for closes), intent, symbol, side, qty/notional, entryCondition (null for closes), proposedTradingDay, proposedSlot, proposedSlotIndex, and expiresAfterTradingDay (the thesis deadline date; null for closes) — report every one with \`disposition: "deferred"\`, and stop. A close intention stores the held qty; a LONG entry intention stores its notional; a SHORT entry intention stores its target notional with qty null — whole-share qty derives at submission (rule 4), never at deferral, so the price is never stale. Deferral is the correct action, not a failure.

When the market IS open:
0. Before submitting ANYTHING, list orders once (status=all, direction=desc, limit=500). Any order you were about to submit whose client order id ALREADY exists at the broker settles as \`disposition: "duplicate"\` without a submission — a retried task must never re-send a batch the broker already has.
1. FIRST settle pending intentions, before this cycle's new orders. List \`/portfolio/intentions/\`. An ENTRY intention whose thesis deadline has passed is expired: delete its doc, report \`disposition: "expired"\`, never submit it — its thesis resolves entry_failed, not late. An ENTRY intention is submittable only when its thesis doc exists at \`/portfolio/theses/open/{thesisId}.json\` — one with no thesis doc behind it was orphaned by a crashed cycle that re-decided: delete it and report \`disposition: "expired"\` with \`error\` naming the missing thesis doc. No order without a registered thesis applies to intentions too. An ENTRY intention with no \`approvedId\` was never approved: delete it and report \`disposition: "expired"\` with \`error\` naming the missing approvedId. Close intentions never expire — a held position must still be closed. An ENTRY intention is due only when its stored \`entryCondition\` is null or reads as met on a fresh snapshot. One not yet due stays in the ledger untouched and gets no order result this cycle. Submit the due survivors under the clientOrderId stored in each doc, oldest first, closes before entries. A short ENTRY intention (intent open, side sell) submits whole-share qty derived per rule 4 from its stored notional target — never the stored notional itself. An intention gets ONE settlement: delete its doc once it settles as submitted, duplicate, expired, or failed — a failed ENTRY intention's thesis resolves entry_failed via the record step, never a silent retry next cycle. The one exception: a failed CLOSE intention keeps its doc and retries next open-market cycle — a held position must still be closed.
2. Then this cycle's orders: resolution closes and \`repairCloses\` first, then entries — closing frees capital for the entries.
3. Close orders: market, day, opposite side of the thesis direction (long → sell, short → buy), quantity = \`closeQty\`. INVARIANT: across the whole batch (resolution closes + repairCloses + close intentions), the summed close quantity per symbol must never exceed the currently held quantity — trim the LAST closer's qty to the held remainder and record the trim in its \`error\` field; a close crossing zero opens an opposite position, which is exactly the flip this rule exists to prevent.
4. Entry orders: market, day, side from direction (long → buy, short → sell). A LONG entry sizes by notional = sizePct / 100 × equity, rounded to 2 decimals, sent as a string. A SHORT entry sizes in whole shares — the broker rejects fractional/notional short sales — qty = floor(targetNotional / latest price), sent as a whole-number string, priced from one batch snapshots call at submission time covering every shorted symbol. Latest price = the snapshot's latest trade price, falling back to the current session's daily bar close; NEVER the previous day's close — a stale-low reference over-sizes the fill past the target on a gap-up. targetNotional is sizePct / 100 × equity for a thesis entry, or the notional stored on a deferred intention. qty 0 means one share costs more than the target size: submit nothing and report \`disposition: "failed"\` with \`error\` naming the share price vs the target — the thesis resolves entry_failed downstream. Rounding down keeps every entry at or under its target size.
5. Every order's client order id is deterministic: "{tradingDay}-{slotKey}-{thesisId}-close" or "{tradingDay}-{slotKey}-{thesisId}-open", minted by the cycle that PROPOSED the order and carried unchanged through deferral. If this cycle is re-run after a crash, the broker rejects the duplicate id instead of double-placing — that rejection is \`disposition: "duplicate"\` (rule 6): the prior run's submission stands.
6. Gate every result on the HTTP status, per order: record the call's status in \`statusCode\`. Only a 2xx with an order id in the body is \`disposition: "submitted"\`. A rejection naming the client order id as already used is \`disposition: "duplicate"\` — the order landed in a prior run; count it in neither submittedCount nor failedCount, and leave its fill truth to next cycle's resolution. Any other 4xx/5xx is \`disposition: "failed"\` — a plausible-looking body never overrides the status. Record the broker's error message verbatim in \`error\` and continue with the remaining orders; never abort the batch, never silently count a rejection as success, never retry a rejection with altered parameters.
7. Wash-trade remediation — the ONE exception to rule 6's no-retry: a 403 rejecting an exit because an opposite-side order is open names the blocking order id. When that blocker is our own stale unfilled ENTRY (its client order id carries one of our thesisIds), cancel it by broker order id, then resubmit the exit once. Report the exit result normally; the cancelled entry's thesis resolves entry_failed next cycle. Cancel NOTHING else — the cancel tool exists for exactly this remediation.
8. Fill verification — after all submissions, poll each submitted order once by its broker order id (your order-status tool) and report \`fillState\`: "filled", "partial", or "pending". Fill truth is read from the broker, never assumed from a 2xx. A duplicate has no broker order id this run — its \`fillState\` stays null and next cycle's resolution reads its fill truth.
9. Submit NO order that is not in your inputs or the intentions ledger. The validated thesis/resolution arrays are the complete authority — that is the thesis-discipline invariant: no order without a pre-registered thesis.
10. If the order tool is missing from your toolbox, exit via your blocked-signal with a reason naming the missing capability — do not fabricate results.

Output (submit_output) — one result per proposed order AND per settled intention:
{
  slot: "pre_market" | "open" | "intraday" | "after_close",   // copied from your input
  orderResults: [
    {
      clientOrderId: string,
      thesisId: string,
      approvedId: string | null,   // the thesis's approvedId on an entry; null on a close
      intent: "open" | "close",
      symbol: string,
      side: "buy" | "sell",
      qty: string | null,          // closes (held quantity verbatim — may be fractional) and short entries (whole shares)
      notional: string | null,     // long entries; for a short, the target its qty derived from
      entryCondition: string | null,   // the thesis's entry condition, or null on a close
      disposition: "submitted" | "duplicate" | "deferred" | "expired" | "failed",
      statusCode: number | null,   // HTTP status of the broker call; null for deferred/expired
      orderId: string | null,      // broker order id when submitted
      orderStatus: string | null,  // broker status when submitted
      fillState: "filled" | "partial" | "pending" | null,   // same-cycle poll; null when not submitted this run
      error: string | null         // verbatim broker error when failed or duplicate
    }
  ],
  submittedCount: number,
  deferredCount: number,
  failedCount: number
}`;

export const DAILY_CYCLE_RECORD_PROMPT = `Append this cycle to the thesis ledger and extract learnings from this cycle's resolutions — the ledger is the substrate every process metric derives from, so write exactly what happened.

Inputs (already in your task context):
- \`tradingDay\`, \`slot\`, \`slotIndex\`, \`coverageNote\` — the cycle identity + coverage honesty note. \`{slotKey}\` is the slot, or \`intraday-{slotIndex}\` on an intraday cycle.
- \`resolutions\` — this cycle's resolved theses.
- \`orphanFlattens\` — orphan positions this cycle flattened (the account is single-owner; nothing is left unmanaged).
- \`theses\`, \`decisionRationale\`, \`projectedGrossExposurePct\` — this cycle's decisions.
- \`approvedSetFault\` — the approved-set fault decide named, or null. A fault opened nothing this cycle: name it in \`runSummary\` and set \`approvedSetFaults\` to 1, else 0.
- \`lensRecordGaps\` — 1 when a thesis in \`openedApprovals\` or \`thesesResolved\` carries no desk lens record (its \`lenses\` is null or another value), else 0. Such a thesis cannot enter the per-lens comparison.
- \`orderResults\`, \`submittedCount\`, \`deferredCount\`, \`failedCount\` — what actually landed at the broker, was deferred, or failed.
- \`equity\`, \`cash\`, \`positions\` — the account state ingested at cycle START, before this cycle's orders.
- \`regimeName\`, \`hypotheses\` — the campaign and its hypothesis arms.
- Prior learnings — auto-injected.

Ledger writes (JSON docs; the contracts are documented in /portfolio/theses/SCHEMA.md):
1. For each resolution: write \`/portfolio/theses/resolved/{thesisId}.json\` — the full original thesis doc plus \`outcome\`, \`entryFillState\`, \`resolvedTradingDay\`, \`resolvedSlot\`, \`resolvedSlotIndex\`, \`resolutionEvidence\`, and the close order result (or its absence) — then delete \`/portfolio/theses/open/{thesisId}.json\`. An \`entry_failed\` resolution carries the order facts and NO close order, NO P&L, NO position narration — no position ever existed.
2. For each of this cycle's theses: write \`/portfolio/theses/open/{thesisId}.json\` carrying every thesis field verbatim, \`hypothesisId\`, \`approvedId\`, \`reviewRunId\` and \`lenses\` included, plus \`regimeName\`, \`openedTradingDay\`, \`openedSlot\`, \`openedSlotIndex\`, \`statedConfidence\`, and its entry order result. The contract refuses any doc under \`/portfolio/theses/open/\` or \`/portfolio/theses/resolved/\` without \`thesisId\`, \`regimeName\` and \`hypothesisId\`, the docs this cycle writes included. Campaign start archived every earlier campaign's docs, so each doc you resolve carries all three. Status follows the entry's disposition: submitted → \`"open"\` (with its fillState), duplicate → \`"open"\` (the prior run's submission stands), deferred → \`"entry_pending"\`, failed → \`"entry_failed"\` with the broker error on it — a failed entry is evidence, not something to hide.
3. For each order result whose thesisId is NOT among this cycle's theses (a settled intention or a remediation on a prior thesis): an ENTRY submission (or duplicate) replaces the open doc's \`status: "entry_pending"\` with \`"open"\` and records the result; a FAILED or expired entry intention sets \`status: "entry_failed"\` with the error on it; a settled CLOSE belongs to a thesis already resolved — patch its \`closeOrder\` on \`/portfolio/theses/resolved/{thesisId}.json\` with the settled result, so the close truth lands on the resolved doc instead of nowhere.
4. Produce the snapshot as the \`snapshotDoc\` OUTPUT FIELD — you do not write it to memory yourself; a dedicated operation step persists it at \`snapshotDocPath\`. It carries: equity, cash, positions, \`orphanFlattens\` verbatim (the orphans reconciled this cycle), and BOTH gross numbers — \`brokerGrossExposurePct\` (sum of ALL absolute position notionals at cycle start ÷ equity × 100) and \`grossExposurePct\` (campaign-attributed: subtract the orphanFlattens' absolute notionals before dividing — they are being cleared, not held as strategy). \`grossExposurePct\` is the cap-scored number. Positions in \`repairCloses\` are thesis-attributed AND being closed this cycle — count them in the gross like any other thesis position.
5. Produce the cycle doc as the \`cycleDoc\` OUTPUT FIELD — tradingDay, slot, slotIndex, coverageNote, opened thesisIds, resolved thesisIds with the hypothesisId and the \`lenses\` record their ledger doc carries (null where it carries none) and outcome, \`openedApprovals\` (one { thesisId, approvedId, reviewRunId, lenses } per thesis opened, empty on a resolve-only cycle), \`approvedSetFault\` (copied from your input: the approved-set fault decide named, or null), order counts (submitted / deferred / failed), projectedGrossExposurePct, decisionRationale. A dedicated operation step persists it at \`cycleDocPath\` LAST — its existence marks the cycle complete, so a crashed cycle re-runs, never half-records. \`cycleDocPath\` and \`snapshotDocPath\` are validated against the ledger contract — only \`/portfolio/theses/cycles/{tradingDay}-{slotKey}.json\` and \`/portfolio/snapshots/{tradingDay}-{slotKey}.json\` pass.
6. Echo every thesis-doc write in your output — \`resolvedDocPaths\`, \`openedDocPaths\`, \`deletedOpenDocPaths\` — exactly the docs you wrote or deleted in steps 1–3. The echoes are validated against the contract path shapes: a write outside \`/portfolio/theses/resolved/\` or \`/portfolio/theses/open/\` cannot be reported, so do not make one.
7. The per-arm table — after_close only, AFTER every write above. List the docs under \`/portfolio/theses/open/\` and \`/portfolio/theses/resolved/\` whose \`regimeName\` is this campaign's. Give each arm in \`hypotheses\` one row: \`opened\` = its theses, \`open\` = those with no resolved doc, \`resolved\` = its resolved docs counted by outcome. A thesis with both docs counts once, as resolved. Put the table in \`armTable\` and in \`snapshotDoc.armTable\`. On every other slot both are null. The contract recounts the ledger and refuses a row it does not give.

Learnings — from RESOLUTIONS ONLY:
- At most one learning per resolution; zero resolutions this cycle means zero learnings (your output contract enforces the cap).
- Each learning's \`detailRef\` is the resolved thesis doc path — that citation is the resolution it rests on. No learning without a resolved thesis behind it.
- A resolution of a FILLED trade is a clean truth event: what was predicted, what the prices did, whether the stated confidence was warranted. Record the specific, reusable fact — "3 of 3 breakout theses on low-volume setups falsified within 2 days" is a learning; "be more careful" is not.
- An \`entry_failed\` resolution teaches PROCESS facts only — submission timing, order shape, expiry behavior (e.g. "orders queued while the market is closed never fill on this account"). It carries no market evidence: the prediction was never tested, so no calibration point and no market learning may cite it.
- A \`tactical_exit\` resolution closed a filled trade before either criterion triggered. It may teach about exits, but it tested neither criterion, so it is no calibration point.
- Do not extract learnings from unresolved theses, order mechanics of successful fills, or hunches about the market. A hypothesis without a resolution stays a hypothesis — mark it \`category: "hypothesis"\` with \`confidence: "low"\` only if a resolution genuinely suggests it.

Output (submit_output):
{
  runSummary: string,          // 2-3 sentences: cycle identity, resolutions with outcomes, theses opened, order failures
  cycleCompleted: 1,
  thesesOpened: number,
  thesesResolved: number,
  grossExposurePct: number,        // thesis-attributed gross from the snapshot — the cap-scored number
  brokerGrossExposurePct: number,  // raw broker gross from the snapshot, orphans included
  cycleDoc: object,                // the cycle document content — persisted for you at cycleDocPath, last
  snapshotDoc: object,             // the snapshot content — persisted for you at snapshotDocPath
  cycleDocPath: string,            // /portfolio/theses/cycles/{tradingDay}-{slotKey}.json — shape-validated
  snapshotDocPath: string,         // /portfolio/snapshots/{tradingDay}-{slotKey}.json — shape-validated
  resolvedDocPaths: string[],      // echo of resolved-thesis docs written
  openedDocPaths: string[],        // echo of open-thesis docs written
  deletedOpenDocPaths: string[],   // echo of open-thesis docs deleted
  armTable: { regimeName: string, arms: [ { hypothesisId: string, opened: number, open: number, resolved: { confirmed: number, falsified: number, tactical_exit: number, expired: number, entry_failed: number } } ] } | null,   // after_close only
  approvedSetFaults: 0 | 1,        // 1 when approvedSetFault is not null
  lensRecordGaps: 0 | 1,           // 1 when a thesis opened or resolved carries no lens record
  learnings: [ ... ]           // the platform validates this shape; a downstream step persists it
}`;
