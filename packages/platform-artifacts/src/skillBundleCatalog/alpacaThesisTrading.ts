import type { AuthoredSkillBundle } from '../skillBundleCatalog.js';
import {
  ALPACA_ACCOUNT_READ_API_DEFINITION,
  ALPACA_MARKET_DATA_API_DEFINITION,
  ALPACA_PAPER_ORDERS_WRITE_API_DEFINITION,
  ALPACA_PAPER_KEY_ID,
  ALPACA_PAPER_SECRET_KEY,
} from './alpacaApiDefinitions.js';
import {
  AS_OF_RULE,
  CALENDAR_SOURCE_API_ID,
  CALENDAR_SOURCE_ENDPOINT_ID,
  INDEX_LOOKBACK_SESSIONS,
  INDEX_SERIES_RULE,
  MEMBER_LOOKBACK_SESSIONS,
  MEMBER_SERIES_RULE,
  PRE_MARKET_EVIDENCE_MAX_CHARS,
  PRE_MARKET_NOTE_PATH_TEMPLATE,
  REGIME_MATH_RULE,
  REGIME_READ_BINDING_ID,
  REGIME_STATE_RULE,
  SESSION_COMPLETED_RULE,
} from '../skillCatalog/dailyTradingCycleRegime.js';
import {
  CLOSE_REPORT_PATH_TEMPLATE,
  CLOSE_REPORT_SECTIONS,
  REFLECTION_PATH_TEMPLATE,
} from '../skillCatalog/dailyTradingCycleCloseReport.js';

const ALPACA_THESIS_LEDGER_SCHEMA_DOC = `# /portfolio/theses/ — the thesis ledger

The substrate for every process metric and for campaign-end synthesis. All
docs are JSON. The unit of decision, measurement, and learning is the
**thesis**, never the trade.

## Slots

Every cycle belongs to one (tradingDay, slot). A trading day has four kinds of
slot, and each cycle's task contracts hold what its slot may do:

- \`pre_market\` — before the open. It resolves nothing on price it cannot see
  (only \`entry_failed\` on order facts). It forms the day's theses and writes each
  as a deferred intention with its entry condition. It submits no order.
- \`open\` — shortly after the open. It submits due intentions and resolves open
  theses on current prices: falsification, confirmation or a tactical exit. It
  may form new theses under the day's remaining cap.
- \`intraday\` — the hourly recalibrations while the market is open, numbered by
  \`slotIndex\` from 1. Each may do what \`open\` does.
- \`after_close\` — after the close. It resolves on the close, reconciles and
  records. It forms no new entry.

\`{slotKey}\` in ledger paths and client order ids is the slot, or
\`intraday-{slotIndex}\` on an intraday cycle (e.g. \`2026-07-14-intraday-3\`).
Every ledger doc carries the slot name and its index (null outside intraday).
The campaign's \`maxThesesPerDay\` caps new theses across all slots of one
trading day.

## Hypothesis arms

A campaign tests several named hypotheses side by side, one arm each. Its
\`hypotheses\` field gives each an \`id\`, a \`name\`, a \`statement\` and a
\`thesisBudgetPerDay\`, and no arm's budget may exceed \`maxThesesPerDay\`.
Every thesis cites its arm in \`hypothesisId\`, and the decide contract refuses
an id the campaign does not declare. An arm may open at most its budget in one
trading day, earlier slots included, counted from the thesis docs. Every
thesis doc names its campaign in \`regimeName\` and its arm in
\`hypothesisId\`. The record contract refuses, on every slot, a doc under
\`/portfolio/theses/open/\` or \`/portfolio/theses/resolved/\` without its
\`thesisId\`, \`regimeName\` or \`hypothesisId\`, so no thesis drops out of a
count.

## Campaign start archive — \`/portfolio/archive/theses/{stamp}-{regimeName}/\`

The live ledger holds one campaign's docs. When \`workflow.campaign.start\`
creates a campaign, it first moves every doc under \`/portfolio/theses/open/\`
and \`/portfolio/theses/resolved/\` to \`open/\` and \`resolved/\` below one
archive folder, in one pass. That covers docs of every earlier campaign and
docs from before hypothesis arms. Their content is untouched, and the start
output lists every move in \`migrations\`. The start is refused while another
campaign of a skill that keeps this ledger is active. Before it moves a doc, the start
reads every universe member's IEX daily bars over the last 100 calendar days
through \`alpaca-market-data-default\`. It refuses a universe with a member
the feed gives fewer than 20 sessions, naming each one, and then moves nothing. The next open cycle
flattens a position whose thesis was archived as an orphan, and expires an
entry intention whose thesis doc is gone. A learning keeps the \`detailRef\`
it was written with, and the archived doc keeps its file name. Never write
to the archive.

## Approved set — \`/research/{tradingDay}/approved-theses.json\`

The **Strategy Desk** skill writes it, before the pre_market and open slots,
and before an intraday slot that has a desk scheduled for it. Its strategist
proposes candidates. Six review lenses, each its own run, approve, revise or
reject each one: fundamentals, macro, technical, prior learnings, prior
decisions and risk. One lens rejection rejects the candidate. Its review run
writes the entries every lens approved under the slot's key, each naming that
run and carrying in \`lenses\` what each lens decided. Each entry names in \`hypothesisId\` the
campaign arm its candidate tests, one of the campaign's \`hypotheses\` ids.
Where the slot can run then, the desk starts its cycle early. An open or
intraday slot cannot run before the market opens, so there the scheduled
cycle of the slot runs it with the set. The schedule of every slot fires its cycle too, so the desk decides
what a cycle opens, never whether it runs.
Each desk run replaces the doc with the entries of its own slot, so slots
already run keep no entries here. Their theses are open in the ledger already.
A slot with no doc, or no approved entry, is a resolve-only cycle by
design: it resolves and records and opens nothing.

Each desk writes its record beside the set, at
\`/research/{tradingDay}/desk-{slotKey}.json\`: whether it wrote a set, why,
and every review round. Each round records what every lens said on every
candidate at
\`/research/{tradingDay}/lens-reviews/{slotKey}-{reviewRunId}-round-{n}.json\`.
Each desk run records how it ended at
\`/research/{tradingDay}/desk-runs/{slotKey}-{runId}.json\`. Its research memo is at
\`/research/{tradingDay}/strategy-memo-{slotKey}.md\`.

A cycle opens a thesis only as an instance of an entry under its own
\`{slotKey}\` whose verdict is \`approved\`. The decide contract reads this doc
and refuses any other thesis. Resolution of open theses never reads it.

The contract accepts the set only from these writers, as the memory store
recorded the doc's current version:
- the operator, through Memory or the API — the writer of record is no session.
- a task of one completed run of another skill in this space, writing in its
  own execution — every entry's \`reviewRunId\` must then name that run.

A set written by any Daily Trading Cycle run, by an agent conversation, or by a
run still in progress is refused. A conversation that started or drove a run is
not that run's writer, so its set is refused too. So is a set that cannot be
read or does not parse. A refused set opens nothing, and it stops nothing else:
the cycle still resolves open theses, closes positions and records. Its cycle
doc names the fault in \`approvedSetFault\`, and the cycle's approved-set-sound
eval fails, on every cycle until the set is repaired. Asking the Helmsman to write the set
therefore does not work. The desk writes it, and an operator may still write
it in Memory.

\`\`\`json
{
  "tradingDay": "<YYYY-MM-DD>",
  "slots": {
    "<slotKey>": [
      {
        "approvedId": "<kebab-case, unique within the slot>",
        "instrument": "<ticker>",
        "direction": "long | short",
        "hypothesisId": "<the id of the campaign hypothesis it tests>",
        "entryLevel": 187.4,
        "invalidationLevel": 184.0,
        "confirmationLevel": 195.0,
        "maxSizePct": 5,
        "horizonTradingDays": 3,
        "reviewerVerdict": "approved | revise | rejected",
        "reviewRunId": "<the review run that wrote the set, or the operator's own review label>",
        "lenses": { "<lens>": { "verdict": "approved", "rounds": [{ "round": 1, "verdict": "revise" }, { "round": 2, "verdict": "approved" }] } }
      }
    ]
  },
  "lensReviews": { "<lens>": { "round1": [{ "candidateId": "<approvedId>", "verdict": "revise", "reason": "<the lens's own words>" }] } }
}
\`\`\`

\`lenses\` holds one key per lens: fundamentals, macro, technical,
priorLearnings, priorDecisions and risk, each with its verdict in every round.
It holds no reason. \`lensReviews\` holds each lens's verdicts and reasons in
every round, keyed by candidateId, written verbatim from the lens runs. So an
entry's reasons are under \`lensReviews.{lens}.round{n}\` at its approvedId. A
set the operator writes may leave both out.

The thesis copies \`approvedId\`, \`reviewRunId\`, \`hypothesisId\` and \`lenses\`, keeps the
entry's instrument and direction, and stays at or under its size and horizon.
Every entry names the campaign arm it tests in \`hypothesisId\`. A set with an
entry that names none does not parse. The arm's daily budget still applies to
a thesis opened from the set.

## Market regime — gathered every cycle

After resolution, every cycle reads the daily bars of SPY, QQQ and IWM, and
those of every universe member, through the \`${REGIME_READ_BINDING_ID}\` binding.
It gathers the market regime from those two reads. It reports the closes it
computed from: the last ${String(INDEX_LOOKBACK_SESSIONS)} completed daily closes of SPY, QQQ and IWM
from the index read, and the last ${String(MEMBER_LOOKBACK_SESSIONS)} of every universe member from the
universe read. No agent reads a close. From them it gives:

- each index's close, 20-day and 50-day average, whether it closes above each,
  and its realized volatility.
- \`realizedVolPct\` — SPY's realized volatility.
- \`breadth\` — the universe members above their 20-day average, of all members,
  and the share.
- \`state\` — risk_on, mixed, risk_off or stressed.

${REGIME_MATH_RULE}. The state: ${REGIME_STATE_RULE}. The gather contract
recomputes every number from the reported closes and refuses any value but the
computed one, exactly as rounded. The flags and the state follow from the
numbers as reported. ${AS_OF_RULE}. ${SESSION_COMPLETED_RULE}. The contract
computes that date from the exchange clock and the read. The contract pins each
index series to the last ${String(INDEX_LOOKBACK_SESSIONS)} completed sessions
ending on asOf, and holds each bar's session and close to the read's bar.
${INDEX_SERIES_RULE}. So a pre_market cycle, and an open or intraday cycle
during the session, end every index series on the session before the trading
day. The contract holds each member series the same way, to the universe read.
${MEMBER_SERIES_RULE}. A member close that differs from the read, a member the
read does not carry, or a series that skips or repeats a session is refused.
So the breadth share, and the state it decides, follow from read closes alone.

No new entries without a regime. When it cannot be gathered, decide names the
state \`unavailable\`, and its contract refuses any new thesis: \`theses\` is
empty and \`bias\` is null. Closes always run. The record and the cycle doc run
on every slot. A decide that fails opens nothing either, a decide whose
contract could not be checked included. The cycle still closes and records
under \`unavailable\`, and the cycle doc records the failure the decide task
recorded, whatever failed it.

## Per-regime caps — the campaign's \`regimeCaps\`

The campaign may cap each regime state, declared at campaign start and frozen
with the rest of the regime:

\`\`\`json
{ "risk_on": { "maxGrossExposurePct": 80, "biases": ["long", "short", "neutral"] }, "risk_off": { "maxGrossExposurePct": 30, "biases": ["short"] } }
\`\`\`

decide names the state it decided under in \`marketState\`, pinned to the
gathered regime, and the \`bias\` of the theses it opens: long when every one is
long, short when every one is short, neutral when they hold both directions,
null when it opens none. Its contract refuses a decision that opens theses with
a projected gross over the state's cap, or with a thesis whose direction the
state's biases do not list, whatever the bias says. A decision that holds both
directions also needs neutral listed. Campaign start refuses neutral without
long and short beside it, because it would admit nothing. A state with no entry is held to the campaign-wide caps alone. A
decision that opens nothing passes in any regime, so the cycle's closes always
run. No state's cap may exceed \`maxGrossExposurePct\`: campaign start refuses
one that does. Campaign start also refuses a campaign without \`regimeCaps\`,
so every running campaign carries caps that parse. Caps that still do not
parse refuse a decision that opens theses with the issue named, never with a
fault a retry would answer. A decision that opens nothing still passes.

## Calendar source — optional

A space may bind a calendar source: an API definition with apiId
\`${CALENDAR_SOURCE_API_ID}\` and an endpoint \`${CALENDAR_SOURCE_ENDPOINT_ID}\` that takes \`date\` (YYYY-MM-DD)
and answers:

\`\`\`json
{ "date": "<YYYY-MM-DD>", "session": "regular | half_day | holiday", "earlyCloseAt": "13:00 | null", "holidayName": "<name> | null", "releases": [{ "time": "08:30", "name": "CPI", "importance": "high" }] }
\`\`\`

With one bound, the cycle reads the trading day's calendar and decide receives
it. The cycle doc and the snapshot carry it as \`calendar\`. Without one, the
optional calendar task fails, decide receives no calendar, and \`calendar\` is
null. This bundle ships no calendar source.

## Pre-market note — \`${PRE_MARKET_NOTE_PATH_TEMPLATE}\`

When the day has this note, decide receives its first ${String(PRE_MARKET_EVIDENCE_MAX_CHARS)}
characters as evidence, with the note's full length in \`totalChars\`. A longer
note arrives cut at that size with \`truncated: true\`, never dropped. The note
is research, never approval: only the approved set opens a thesis.

## Open thesis — \`/portfolio/theses/open/{thesisId}.json\`

\`\`\`json
{
  "thesisId": "<kebab-case, unique>",
  "regimeName": "<the campaign's regimeName>",
  "hypothesisId": "<the campaign hypothesis this thesis is an instance of>",
  "approvedId": "<the approved-set entry it instantiates>",
  "reviewRunId": "<the review run id on that entry>",
  "lenses": "<the lens record on that entry, verbatim, or null>",
  "openedTradingDay": "<YYYY-MM-DD>",
  "openedSlot": "pre_market | open | intraday | after_close",
  "openedSlotIndex": "<intraday firing number, or null>",
  "instrument": "<ticker>",
  "direction": "long | short",
  "rationale": "<the observed setup, with numbers>",
  "entryCondition": "<price condition that makes the entry due, or null>",
  "falsificationCriterion": "<price-checkable condition that proves it wrong>",
  "confirmationCriterion": "<price-checkable condition that proves it right>",
  "deadlineTradingDays": 3,
  "sizePct": 5,
  "statedConfidence": "low | medium | high",
  "entryOrder": { "clientOrderId": "...", "orderId": "...|null", "disposition": "submitted | duplicate | deferred | expired | failed", "statusCode": 200, "fillState": "filled | partial | pending | null", "qty": "...|null", "notional": "...|null", "error": null },
  "status": "open | entry_pending | entry_failed"
}
\`\`\`

The doc lands after order execution, but every field except \`entryOrder\` is
fixed by the validated decision output that preceded the order — the thesis is
pre-registered by construction. A thesis whose orders were deferred as an
intention carries \`status: "entry_pending"\` until the intention is submitted;
a failed or expired entry is written with \`status: "entry_failed"\` and the
broker error on it — a failed entry is evidence.

## Deferred intention — \`/portfolio/intentions/{clientOrderId}.json\`

An order proposed while the market was closed, on a pre_market cycle, or with
an entry condition not yet met. Orders queued against a closed market are never
submitted — they are recorded as intentions. The first open-market cycle that
finds one due submits it, before that cycle's new orders, under the client
order id fixed here. An entry intention is due when its \`entryCondition\` is
null or reads as met on a fresh price. Until then it stays in the ledger.

\`\`\`json
{
  "clientOrderId": "<{tradingDay}-{slotKey}-{thesisId}-open|close, from the proposing cycle>",
  "thesisId": "<thesisId>",
  "approvedId": "<the thesis's approvedId; null for close intentions>",
  "intent": "open | close",
  "symbol": "<ticker>",
  "side": "buy | sell",
  "qty": "...|null",
  "notional": "...|null",
  "proposedTradingDay": "<YYYY-MM-DD>",
  "proposedSlot": "pre_market | open | intraday | after_close",
  "proposedSlotIndex": "<intraday firing number, or null>",
  "entryCondition": "<price condition that makes an entry due, or null>",
  "expiresAfterTradingDay": "<YYYY-MM-DD — the thesis deadline; null for close intentions>"
}
\`\`\`

The doc is deleted when the intention is submitted or expires. A short entry
intention records its target \`notional\`; the submitting cycle derives
whole-share \`qty\` from a fresh price — the broker rejects fractional short
sales. An entry intention whose thesis deadline has passed is expired, never
submitted — its thesis resolves \`entry_failed\`. An entry intention is submittable only when
its open-thesis doc exists; one with no thesis doc behind it (a crashed cycle
that re-decided) is deleted unsubmitted. An entry intention with no
\`approvedId\` is deleted unsubmitted too. Close intentions never expire: a held
position must still be closed, and the settled close is patched onto its
resolved thesis doc.

## Resolved thesis — \`/portfolio/theses/resolved/{thesisId}.json\`

The full open-thesis doc plus:

\`\`\`json
{
  "outcome": "confirmed | falsified | expired | entry_failed | tactical_exit",
  "entryFillState": "filled | partial | none",
  "resolvedTradingDay": "<YYYY-MM-DD>",
  "resolvedSlot": "pre_market | open | intraday | after_close",
  "resolvedSlotIndex": "<intraday firing number, or null>",
  "resolutionEvidence": "<observed prices quoted against the written criterion; for entry_failed, the order-state facts>",
  "closeOrder": { "clientOrderId": "...", "orderId": "...|null", "disposition": "...", "statusCode": 200, "qty": "...|null", "fillState": "filled | partial | pending | null", "error": null }
}
\`\`\`

A thesis resolves exactly one way; the open doc is deleted when the resolved
doc is written. \`entryFillState\` is the explicit fill-truth assertion: only
a thesis whose entry FILLED (\`filled\` or \`partial\`) may resolve confirmed,
falsified, expired, or tactical_exit (an open or intraday close before either
criterion triggers); an unfilled / expired / cancelled / rejected entry
(\`none\`) resolves \`entry_failed\` with no closeOrder, no P&L attribution,
and no position narration — no position ever existed. A close deferred as an
intention is patched onto \`closeOrder\` when it settles — the resolved doc
always ends with the close truth. A resolved thesis whose close never filled
while its position is still held is repaired by the next cycle: resolution
lists it as a repair close (qty = the thesis's own filled entry quantity,
clamped to the held quantity), execution closes it before new entries, and the
settled close is patched here. Every learning cites a resolved thesis doc
via \`detailRef\`.

## Cycle doc — \`/portfolio/theses/cycles/{tradingDay}-{slotKey}.json\`

The idempotency marker: a cycle is complete exactly when its doc exists, and
it is written LAST — a crashed cycle re-runs, it is never half-recorded.

\`\`\`json
{
  "tradingDay": "<YYYY-MM-DD>",
  "slot": "pre_market | open | intraday | after_close",
  "slotIndex": "<intraday firing number, or null>",
  "coverageNote": "<missed slots since the last cycle, named honestly>",
  "thesesOpened": ["<thesisId>"],
  "openedApprovals": [{ "thesisId": "...", "approvedId": "...", "reviewRunId": "...", "lenses": "<the thesis's lens record, or null>" }],
  "approvedSetFault": "<why the approved set approved nothing — unreadable, unparsable or a refused writer — or null>",
  "thesesResolved": [{ "thesisId": "...", "hypothesisId": "<the arm its ledger doc names>", "lenses": "<its ledger doc's lens record, or null>", "outcome": "...", "statedConfidence": "..." }],
  "submittedCount": 2,
  "deferredCount": 0,
  "failedCount": 0,
  "projectedGrossExposurePct": 42.5,
  "decisionRationale": "<why these theses (or why none)>",
  "bias": "long | short | neutral | null — the direction of the theses opened, null when none",
  "marketState": "risk_on | mixed | risk_off | stressed | unavailable",
  "marketRegime": { "asOf": "<YYYY-MM-DD>", "state": "...", "indexes": { "SPY": { ... }, "QQQ": { ... }, "IWM": { ... } }, "realizedVolPct": 14.2, "breadth": { ... } },
  "calendar": null,
  "regimeRead": { "bindingId": "${REGIME_READ_BINDING_ID}", "asOf": "<YYYY-MM-DD>", "count": 68 },
  "decisionFault": "<the failure the decide task recorded when it produced no decision, or null>",
  "preMarketNote": "<the pre-market note decide read as evidence, or null>",
  "preMarketFault": "<the failure the pre-market read recorded, or null>"
}
\`\`\`

The write step adds \`bias\` from decide, \`decisionFault\` from the decide task's failure, \`marketState\`
from the decision-state step, \`marketRegime\` from gather-regime and
\`calendar\` from the calendar task. The record task never copies them, so the
doc shows the regime the decision was made under. \`regimeRead\` is the provenance of the index read the regime was computed from:
the binding, the session it is as of and the SPY bars it returned.
\`marketState\` is \`unavailable\`, and \`marketRegime\` and \`regimeRead\` are null,
when the regime could not be gathered. \`marketState\` is \`unavailable\` and
\`bias\` is null when decide produced no decision, and \`decisionFault\` says so.
\`preMarketNote\` is the path of the note decide read. It is null when the day
has no note, and \`preMarketFault\` is then null too. It is null when the read
failed, and \`preMarketFault\` then holds the failure. A failed read leaves
decide without the evidence, and the cycle still decides, closes, records and
completes.

## Snapshot — \`/portfolio/snapshots/{tradingDay}-{slotKey}.json\`

\`\`\`json
{ "equity": 100000, "cash": 60000, "positions": [ ... ], "brokerGrossExposurePct": 41, "grossExposurePct": 40, "orphanFlattens": [{ "symbol": "...", "qty": "...", "side": "long | short", "evidence": "..." }], "armTable": null, "marketState": "...", "marketRegime": { ... }, "calendar": null }
\`\`\`

\`marketState\`, \`marketRegime\` and \`calendar\` are the cycle's, the same values
the cycle doc holds. The after_close snapshot shows the regime at the close of
the day.

\`grossExposurePct\` is campaign-attributed (broker gross minus the
orphanFlattens' notionals) — the number scored against the campaign cap.
\`brokerGrossExposurePct\` is the raw broker truth, orphans included.
This account is the agent's alone to manage: any broker position that no open
thesis, pending close intention, or resolved-but-unclosed thesis (repair close)
accounts for is an ORPHAN, and every orphan is reconciled — flattened this cycle
back to a state where every position carries a thesis. \`orphanFlattens\` records
what was cleared, with the provenance evidence, so a surprising flatten is
auditable. There is no operator-owned position in this account to leave alone.

\`armTable\` is null except on after_close, where it is the per-arm table:

\`\`\`json
{ "regimeName": "...", "arms": [{ "hypothesisId": "...", "opened": 4, "open": 1, "resolved": { "confirmed": 1, "falsified": 1, "tactical_exit": 1, "expired": 0, "entry_failed": 0 } }] }
\`\`\`

One row per campaign arm, counted over the campaign's open and resolved thesis
docs after the cycle's writes. A thesis with both docs counts once, as
resolved. The record contract recounts the ledger and refuses a row it does
not give, so the table is never a reported number.

## Journal — \`/research/journal/{tradingDay}.md\`

The **Trading Reflection** skill writes one entry per trading day after the
close: an analyst on the machine's coding agent reads the day's cycle docs,
desk records, lens records, resolutions and recent entries, and writes the
entry here. It writes the same entry to \`journal/{tradingDay}.md\` in the
connected folder where the folder allows writes. The desk reads the journal
before it proposes, and its prior-learnings lens reads it before it judges.

The journal is the one record of the day the Strategy Desk reads. The close
report below is another artifact, and no desk reads it.

## Close report — \`${CLOSE_REPORT_PATH_TEMPLATE}\`

The after_close cycle writes it, and no other slot does. It covers the whole
trading day. After the cycle doc is written, the cycle reads that doc and the
after_close snapshot back from the ledger. An agent lists every resolution and
every opening the day's cycle docs record, each with its cycle doc and slot
key, from pre_market through after_close. A reflection gives one reason per
resolution and the candidate changes. Both contracts read the day's cycle
docs, and they refuse an unknown thesis, a wrong outcome or slot, and an entry
left out. The close report holds five sections, each its value as JSON:

${CLOSE_REPORT_SECTIONS.map((heading) => `- ${heading}`).join('\n')}

What resolved holds one entry per resolved thesis of the day: its thesisId,
hypothesisId, outcome, the \`slotKey\` of the cycle that resolved it, and the
reason. The reason is the reflection's account of why the thesis resolved,
grounded in the \`resolutionEvidence\` its resolved doc records. No contract
compares the reason to that evidence, so the resolved doc stays the record of
it. The process metrics are the theses formed over the day against
\`maxThesesPerDay\`, the theses resolved over the day, \`grossExposurePct\`
against \`maxGrossExposurePct\`, the \`marketState\` and the faults the
after_close cycle doc names. The two counts are the lengths of the day's
openings and resolutions the reflection record holds, as their contract held
them to the cycle docs. The per-arm table is the snapshot's \`armTable\`. The
ledger records no R for a resolution, so the table holds no expectancy in R.
Cost is what the after_close cycle doc records: the submitted, deferred and
failed order counts and \`projectedGrossExposurePct\`. Each candidate change is
an observation for the next campaign boundary, tied to the cycle doc, snapshot
or thesis doc fields it rests on, never a decision. The write step binds every
metric, the per-arm table and the cost from the docs, the record's lists and
the campaign. No agent copies them, and no figure comes from resolve-theses.

## Reflection — \`${REFLECTION_PATH_TEMPLATE}\`

The after_close cycle records the reflection here once per trading day:
\`tradingDay\`, \`slot\`, the day's \`resolutions\` and \`thesesOpened\` as the
ledger read listed them, \`reasons\` and \`candidateChanges\`. The close report
takes its reasons, its candidate changes and its two day counts from this doc.
A duplicate after_close trigger finds it, runs no agent and writes a
byte-identical close report.

The close report and the reflection are records only. No task reads the
report, and neither changes a campaign, skill or config.

## Successor draft — \`/research/campaigns/{regimeName}/successor-{runId}.json\`

The **Campaign Successor** skill writes it at a campaign boundary, under the
ending campaign's regimeName. Its strategist drafts the successor's complete
contract in \`config\`, with a carry, revise or drop decision on every arm in
\`arms\`. The six lenses review the draft, and the doc records the
\`verdict\` and what each lens said in \`lenses\`. Only a reviewed draft is
written. The draft is data: the boundary applies it only on verdict
\`approved\`, by ending the campaign and starting the successor with
\`workflow.campaign.start\` and the draft's \`config\` unchanged.

## Market-data cache — \`/portfolio/market-data/{symbol}.json\`

\`\`\`json
{ "symbol": "SPY", "bars": [ { "t": "<YYYY-MM-DD>", "o": 0, "h": 0, "l": 0, "c": 0, "v": 0 } ] }
\`\`\`

The local price-history layer. The resolve step keeps it: it reads this doc
BEFORE calling the market-data feed, fetches only the days it lacks, and
upserts it keeping the most recent 30 daily bars (oldest dropped, newest last).
So the cache holds the instruments resolution reads: open theses, pending
intentions and held positions. The decide step reads it and never writes it.
Bars it needs that the cache lacks, such as index ETFs and candidate
instruments, it fetches fresh from the market-data feed on each cycle, and
they stay uncached.
Only COMPLETED sessions enter the cache — the clock date's bar is still
forming while the market is open, and caching it would freeze a partial bar
as that day's permanent record, corrupting every resolution that later reads
it. Prices cited in criteria resolutions and rationales come from this cache
or a fresh fetch — never from prose in earlier ledger docs.

## How the metrics derive (two layers, never conflated)

**Layer 1 — process (fast, per cycle, the primary signal):**
- Cycle reliability: cycle docs vs the SCHEDULED (tradingDay, slotKey) grid —
  pre_market, open and after_close every trading day, plus the intraday
  indices below the highest one recorded that day. Gaps are named in the next
  cycle's \`coverageNote\`, and no slot outside the schedule counts as missed.
- Thesis discipline: every order in every cycle doc carries a \`thesisId\`, and
  every opened thesis carries the \`approvedId\` and \`reviewRunId\` it was
  approved under.
- Resolution rate: resolved docs vs deadlines; an unresolved-past-deadline
  thesis is a process defect.
- Fill discipline: entry orders resolve to a fill state the same cycle they
  are submitted; \`entry_failed\` resolutions and expired intentions are
  counted, never narrated as trades.
- Calibration: \`statedConfidence\` vs \`outcome\` across resolved docs of
  FILLED trades only — an \`entry_failed\` resolution carries no market
  evidence and is excluded from calibration. A \`tactical_exit\` tested
  neither criterion and is excluded too.
- Arm attribution: every thesis doc in the live ledger names its
  \`hypothesisId\`, and the after_close snapshot's \`armTable\` gives each
  arm's theses opened, open and resolved by outcome.
- Loop health: learnings per resolution ≤ 1, each with a resolved-doc
  \`detailRef\`.
- Review lenses: every opened thesis carries the \`lenses\` record of its
  approved entry, and its resolved doc keeps it beside the outcome. Each lens
  record under \`/research/{tradingDay}/lens-reviews/\` gives what each lens
  rejected. Together they let each lens's rejection rate be set against the
  falsification rate of the theses it approved, read over the window. Each
  cycle's lens-record-carried eval fails when a thesis it opened or resolved
  lost the lens record it held. A thesis that held none, as one from a set the
  operator wrote or one opened before lens records, is not applicable. A set
  the operator writes opens its theses whatever \`lenses\` it holds.
- Exposure discipline: each snapshot's thesis-attributed \`grossExposurePct\`
  vs the campaign cap — the cross-check on the previous cycle's projection;
  the raw \`brokerGrossExposurePct\` stays alongside.

**Layer 2 — outcome (slow, windowed — read ONLY at the weekly checkpoint and
campaign end):** portfolio equity series (from snapshots) vs SPY buy-and-hold
on identical capital over the campaign window; Sharpe + max drawdown over the
same window. Raw daily P&L is not a signal anywhere.

**Boundary rules — declared at campaign start, never tuned mid-campaign:**
- \`pooledSampleFloor\` — the fewest resolutions of filled entries, pooled
  across every arm, before the boundary reads a verdict. Below it the window
  reads inconclusive.
- \`expectancyFloorR\` — the expectancy in R an arm must reach to carry into
  the next campaign. R is a filled thesis's realized return over its risk at
  entry, the distance from entry to its falsification level.
- \`calibrationRule\` — the hit rate each stated confidence claims, and the
  largest gap allowed between that claim and the confirmed share of its
  filled criteria resolutions.
`;

export const ALPACA_THESIS_TRADING: AuthoredSkillBundle = {
  bundleId: 'alpaca-thesis-trading',
  revision: 6,
  name: 'Alpaca Thesis Trading',
  tagline:
    'Thesis-driven intraday paper trading: multi-hypothesis campaigns, structural risk caps, a falsification ledger.',
  description: `Wires up the **Alpaca paper API** (account read, market data, order write), the **Daily Trading Cycle** skill, the **Strategy Desk** skill that prepares its slots, the **Trading Reflection** skill that writes the journal after the close, and the **Campaign Successor** skill that drafts the next campaign at a boundary — long-horizon autonomy on a paper account where the unit of decision, measurement, and learning is the **thesis**: hypothesis arm + instrument + direction + rationale + falsification criterion + confirmation criterion + deadline + size, written and validated before any order exists.

**What you get**:
- The three Alpaca API definitions + default bindings (one set of paper credentials serves all three).
- The **Daily Trading Cycle** skill — one run per (tradingDay, slot): resolve every open thesis against its written criteria, propose new theses under the campaign's frozen regime, execute orders (closes then entries, idempotent client order ids), record everything to the thesis ledger under \`/portfolio/theses/\`. Each slot's task contracts hold what it may do: \`pre_market\` forms theses as deferred intentions and submits nothing, \`open\` and \`intraday\` act on current prices under the day's remaining cap, and \`after_close\` resolves on the close and opens nothing. The \`after_close\` cycle then writes the close report of the whole trading day at \`${CLOSE_REPORT_PATH_TEMPLATE}\`, a record only that no desk reads.
- The **Strategy Desk** skill — one run before the pre-market slot and one before the open, and one before any intraday slot you schedule a desk for. A strategist on the machine’s coding agent reads the folder’s journals and strategy records and the ledger, reads the regime, and proposes candidate theses under the frozen campaign caps. Six review lenses, each its own run, approve, revise or reject each one, and any one lens may veto it, with at most two revise rounds. Each approved entry records what each lens said. The desk writes the approved set, then starts the cycle for the slot early where the slot can run then. When nothing is approved, the desk records why. The slot's scheduled cycle runs either way, so resolution never waits on the desk.
- The **Trading Reflection** skill — one run after the close, started by the Helmsman's after-close schedule. An analyst on the machine’s coding agent reads the day's records and writes the journal entry for the trading day. The journal is the record the Strategy Desk reads next.
- The **Campaign Successor** skill — one run at a campaign boundary. A strategist on the coding agent drafts the successor campaign's contract from the ledger, the lens records and the goals, and the six lenses review it. The draft is recorded with its verdict, and the boundary applies it only when every lens approves.
- The thesis-ledger schema doc — the contract every process metric derives from.

**Several hypotheses per campaign**: a campaign tests named hypotheses side by side, one arm each, and every thesis cites its arm by id. Each arm has its own daily thesis budget. The after_close cycle reports a per-arm table of theses opened, open and resolved by outcome, counted from the ledger.

**Market regime and per-regime caps**: every cycle gathers the market regime from the market-data binding. It reads SPY, QQQ and IWM against their 20-day and 50-day averages, SPY's realized volatility, and the share of universe members above their 20-day average. The index closes and the member closes come from two reads through the binding, never from an agent, and the cycle doc records the index read's binding, asOf and count. The contract computes asOf from the exchange clock, and it recomputes each number from the closes the cycle reports, and the numbers give one state: risk_on, mixed, risk_off or stressed. The campaign's \`regimeCaps\` may cap each state's gross exposure and the biases (long, short, neutral) its decisions may take. The decide contract refuses a decision that opens theses past them. No new entries without a regime. When the regime cannot be gathered, decide names the state \`unavailable\`, and its contract refuses any new thesis. Closes always run: the cycle still closes, records and completes on every slot, after_close included. A decide that fails, or whose contract cannot be checked, opens nothing, and the cycle still closes and records under \`unavailable\`. A calendar source the space binds adds the day's calendar: half days, holidays and known macro releases. The day's pre-market note at \`/research/{tradingDay}/pre-market.md\` reaches decide as evidence, cut at a fixed size and marked truncated. The cycle doc and the snapshot carry the state each decision was made under, with the regime, or null where it was unavailable.

**No human gate**: paper trading carries zero financial risk; the safety layer is the structural risk-gate — campaign caps (universe, hypothesis arms and their daily budgets, theses/day, per-position %, gross exposure, horizon bounds) are bound into the decide task's output contract and violations are rejected by schema validation.

**Approved theses only**: a cycle opens a thesis only from the reviewed approved set at \`/research/{tradingDay}/approved-theses.json\` for its slot. A slot with no approved set resolves and records and opens nothing. The **Strategy Desk** writes the set before each slot it prepares, so no one writes it by hand. A space that updates to this revision through Store → Update adds the desk schedules step 3 names, and keeps its cycle schedules.

**After install**:
1. Add your Alpaca paper API key id + secret in Integrations (one credential pair, reused by all three bindings).
2. Start a campaign: regime name, the hypotheses it tests (each with an id, a name, a statement and a daily thesis budget no larger than the theses/day cap), universe, caps, the per-regime caps (\`regimeCaps\`: for each market-regime state you cap, a gross exposure cap no higher than the campaign-wide one and the biases it allows, or \`{}\` for none), horizon bounds, the pre-registered evaluation window, and the boundary rules (pooled sample floor, expectancy floor in R, calibration rule). The regime is frozen mid-campaign — strategy evolves at campaign boundaries. Start it with workflow.campaign.start. Campaign start refuses a campaign without \`regimeCaps\`. It also reads every universe member's IEX daily bars over the last 100 calendar days through the market-data binding, and refuses a member with fewer than 20 sessions as CAMPAIGN_START_CHECK_REFUSED, naming it and its count. Drop or replace that member, then start again. A campaign started before this version has none, so its decide task fails each cycle and the cycle doc records why: end it and start a new one after updating. The start moves every thesis doc of an earlier campaign or version to /portfolio/archive/theses/ in one pass, content untouched, and lists each move in its output. The next open cycle flattens the positions of the archived open theses as orphans.
3. Connect the folder that holds the desk’s journals and strategy records. Then create the cron schedules, in exchange time (America/New_York), weekdays. Stagger them off round boundaries, so they do not fire with every other job on the hour. Each slot fires the cycle on its own schedule, whatever any desk ends in:
   - a **pre-market** firing (e.g. 08:47) with \`{ slot: "pre_market" }\` — research and the day's theses before the open, no orders.
   - an **open** firing (e.g. 09:37) with \`{ slot: "open" }\` — submits the due intentions.
   - **hourly intraday** firings (e.g. 10:07 through 15:07) with \`{ slot: "intraday" }\` — each is numbered by the hour of the session it fires in, counted from the 09:30 open (10:07 is \`intraday-1\`, 11:07 is \`intraday-2\`). A schedule per hour may pass \`slotIndex\` itself, counted the same way.
   - an **after-close** firing (e.g. 16:23) with \`{ slot: "after_close" }\` — resolves on the close and records. It then writes the close report at \`${CLOSE_REPORT_PATH_TEMPLATE}\` in Memory from the day's cycle docs and the thesis ledger. It covers every slot of the day: what resolved, with the slot that resolved each thesis and the reflection's account of why, the Layer-1 process metrics, the per-arm table, the cost the after_close cycle doc records and candidate changes for the next campaign boundary. Every metric, count and cost comes from the day's cycle docs, the snapshot and the campaign, never from an agent's own figure. The close report is a record only. No task or desk reads it, and it changes no campaign, skill or config. The cycle records the reflection at \`${REFLECTION_PATH_TEMPLATE}\` once per day with the day's resolutions and openings, so a duplicate trigger runs no agent and writes a byte-identical report.

   Then fire the **Strategy Desk** well ahead of the slots that open theses, with \`{ bindingId, tradingDay: { "$now": "date" }, slot }\`: a **pre-market** desk (e.g. 07:53) with \`slot: "pre_market"\` and an **open** desk (e.g. 08:53) with \`slot: "open"\`. The pre-market desk writes its set and starts the pre_market cycle early, while the market is closed. The open desk writes its set before the open. An open cycle cannot run then, so the desk starts none, and the 09:37 cycle opens from the set. A desk that approves nothing writes no set, and the slot's scheduled cycle runs resolve-only.

   Intraday cycles open theses only from a set an intraday desk wrote for their slot. Without one they resolve, submit due intentions and open nothing. Desks run one at a time: a desk that fires while another runs ends review_refused. To open intraday theses, add a desk for that slot with its \`slotIndex\`, at least 45 minutes before its cycle and when no other desk runs.

   Missed slots self-heal: the next cycle resolves everything pending and records the gap honestly.

   After the close, the Helmsman's own after-close schedule (e.g. 16:45) starts the **Trading Reflection** with \`{ bindingId, tradingDay }\`. Its analyst writes the journal entry for the trading day, which the Strategy Desk reads, and the Helmsman supervises the run and writes no reflection itself.
4. At a campaign boundary, before the campaign ends, run the **Campaign Successor** with \`{ bindingId }\`. Apply its draft only on boundaryOutcome draft_approved: end the campaign, then start the successor with the draft's config.
5. The desk writes each slot’s approved set to \`/research/{tradingDay}/approved-theses.json\` — the shape is in \`/portfolio/theses/SCHEMA.md\`. No one writes it by hand. To steer what the desk proposes, keep journals, strategy records and boundary rules in the folder, and notes under \`/research/notes/\` in Memory. A set the Helmsman or any cycle run writes is refused.
6. Optional: write the day's research note to \`/research/{tradingDay}/pre-market.md\`. decide reads its first ${String(PRE_MARKET_EVIDENCE_MAX_CHARS)} characters as evidence, and a longer note arrives marked truncated. A read that fails leaves decide without it, and the cycle doc names the fault in \`preMarketFault\`.
7. Optional: bind a calendar source, an API definition \`${CALENDAR_SOURCE_API_ID}\` with a \`${CALENDAR_SOURCE_ENDPOINT_ID}\` endpoint shaped as \`/portfolio/theses/SCHEMA.md\` says. Without one, the optional calendar task fails each cycle and the regime carries no calendar.`,
  tags: ['alpaca', 'paper-trading', 'theses', 'campaigns', 'autonomy'],
  skillCatalogIds: [
    'daily-trading-cycle',
    'strategy-desk',
    'trading-reflection',
    'campaign-successor',
  ],
  prerequisiteBundleIds: [],
  apiDefinitions: [
    ALPACA_ACCOUNT_READ_API_DEFINITION,
    ALPACA_MARKET_DATA_API_DEFINITION,
    ALPACA_PAPER_ORDERS_WRITE_API_DEFINITION,
  ],
  apiBindingTemplates: [
    {
      bindingId: 'alpaca-account-read-default',
      apiId: 'alpaca-account-read',
      name: 'Alpaca Account Read (default)',
      description:
        'Read-only access to the operator-owned Alpaca paper account: clock, account, positions, orders.',
      authShape: { type: 'basic' as const },
      credentialSlots: [
        {
          authField: 'usernameCredentialKey',
          credentialKey: ALPACA_PAPER_KEY_ID,
          role: 'username' as const,
          label: 'Alpaca paper API key id',
        },
        {
          authField: 'passwordCredentialKey',
          credentialKey: ALPACA_PAPER_SECRET_KEY,
          role: 'password' as const,
          label: 'Alpaca paper API secret key',
        },
      ],
      egressPolicy: {
        allowedHosts: ['paper-api.alpaca.markets'],
        allowedMethods: ['GET'],
      },
      conflictPolicy: 'skip' as const,
    },
    {
      bindingId: 'alpaca-market-data-default',
      apiId: 'alpaca-market-data',
      name: 'Alpaca Market Data (default)',
      description:
        'Read-only market data (snapshots, bars) — the price evidence theses cite and resolve against.',
      authShape: { type: 'basic' as const },
      credentialSlots: [
        {
          authField: 'usernameCredentialKey',
          credentialKey: ALPACA_PAPER_KEY_ID,
          role: 'username' as const,
          label: 'Alpaca paper API key id',
        },
        {
          authField: 'passwordCredentialKey',
          credentialKey: ALPACA_PAPER_SECRET_KEY,
          role: 'password' as const,
          label: 'Alpaca paper API secret key',
        },
      ],
      egressPolicy: {
        allowedHosts: ['data.alpaca.markets'],
        allowedMethods: ['GET'],
      },
      conflictPolicy: 'skip' as const,
    },
    {
      bindingId: 'alpaca-paper-orders-write-default',
      apiId: 'alpaca-paper-orders-write',
      name: 'Alpaca Paper Orders Write (default)',
      description:
        'Order submission (POST) and cancellation (DELETE). Granted to exactly one task (execute-orders), whose inputs are the validated thesis and resolution arrays — every order carries a pre-registered thesis by construction.',
      authShape: { type: 'basic' as const },
      credentialSlots: [
        {
          authField: 'usernameCredentialKey',
          credentialKey: ALPACA_PAPER_KEY_ID,
          role: 'username' as const,
          label: 'Alpaca paper API key id',
        },
        {
          authField: 'passwordCredentialKey',
          credentialKey: ALPACA_PAPER_SECRET_KEY,
          role: 'password' as const,
          label: 'Alpaca paper API secret key',
        },
      ],
      egressPolicy: {
        allowedHosts: ['paper-api.alpaca.markets'],
        allowedMethods: ['POST', 'DELETE'],
      },
      conflictPolicy: 'skip' as const,
    },
  ],
  memorySeed: [
    {
      path: 'portfolio/theses/SCHEMA.md',
      content: ALPACA_THESIS_LEDGER_SCHEMA_DOC,
      docType: 'markdown' as const,
      description:
        'Thesis-ledger contract: approved set / thesis / cycle / snapshot doc shapes and how the two metric layers derive from them.',
      // The platform's own contract, not an operator doc: an update must
      // deliver the approved-set shape the cycle now reads.
      seedPolicy: 'overwrite' as const,
    },
  ],
  helmsmanHints: [
    'Add the Alpaca paper API key id + secret in Integrations before running — one credential pair serves the account-read, market-data, and orders-write bindings.',
    'To run the Daily Trading Cycle, call workflow.run.start({ slug }). The first run rejects with CAMPAIGN_REQUIRED carrying the contract fields (regime name, hypotheses, universe, theses/day, position, gross and per-regime caps, horizon bounds, evaluation window, pooled sample floor, expectancy floor in R, calibration rule). Collect them once and call workflow.campaign.start({ slug, config: { … } }), which reports what its migration moved. Then re-issue workflow.run.start({ slug }).',
    'A campaign carries several named hypotheses, each { id, name, statement, thesisBudgetPerDay }. Every thesis cites one by hypothesisId, and no arm’s budget may exceed maxThesesPerDay. A campaign from before multi-hypothesis campaigns cannot run on this version: end it and start a new one. Campaign start archives every earlier thesis doc in one pass and lists each move in migrations. Tell the operator what moved. The runtime refuses a live thesis doc without thesisId, regimeName and hypothesisId.',
    'The campaign regime is FROZEN mid-window, and its boundary rules are never tuned mid-campaign. At the boundary, before the campaign ends, start campaign-successor with { bindingId }: its strategist drafts the next contract and six lenses review it. Apply the draft only on boundaryOutcome draft_approved: end the campaign, then call workflow.campaign.start with the draft’s config unchanged. Never draft the contract yourself.',
    'Set up the cron schedules in America/New_York on weekdays, staggered off round boundaries: pre-market (e.g. 47 8 * * 1-5), open (37 9 * * 1-5), hourly intraday (7 10-15 * * 1-5) and after-close (23 16 * * 1-5). Each schedule input asks for workflow.run.start({ slug, inputs: { slot } }) with its slot: pre_market, open, intraday or after_close. An intraday slotIndex counts session hours from the 09:30 open, so 10:07 is intraday-1, derived or passed.',
    'Fire the strategy-desk ahead of the slots that open theses: pre-market (e.g. 53 7 * * 1-5) with slot: "pre_market" and open (53 8 * * 1-5) with slot: "open", each input { bindingId, tradingDay: { "$now": "date" }, slot }. The desk starts the cycle early where the slot can run, so the open desk starts none and the open cycle opens from its set. It never replaces the cycle schedules, which run every slot whatever the desk ends in.',
    'Each slot does only what its contracts allow. pre_market forms the day’s theses as deferred intentions with entry conditions and submits nothing. open and intraday submit due intentions, resolve on current prices and may form theses under the day’s remaining cap. after_close resolves on the close and opens nothing. Runs are idempotent per (tradingDay, slot) and self-heal missed slots, so an overdue firing on stack startup is safe. A run with no slot derives it from the clock.',
    'A cycle opens theses only from the approved set at /research/{tradingDay}/approved-theses.json, which the Strategy Desk writes. You supervise and form no theses: check the desk and cycle runs hourly. Your after-close schedule (e.g. 45 16 * * 1-5) starts trading-reflection with { bindingId, tradingDay }. Its analyst writes the journal. Report its reflectionOutcome and write no reflection. If no thesis opens, read the desk records under /research/{tradingDay}/. Never write the set yourself.',
    'Each cycle gathers the market regime (risk_on, mixed, risk_off or stressed) from index and universe closes. regimeCaps maps a state to { maxGrossExposurePct, biases }, none over maxGrossExposurePct, and {} caps no state. biases hold each thesis by its direction, and neutral, which lets a decision hold both, needs long and short beside it. A cycle without a regime decides under unavailable, opens no thesis and still closes. Campaign start refuses a campaign without regimeCaps.',
    'There is no human approval gate on orders: paper trading carries zero financial risk and the campaign caps are enforced structurally in the decide contract. Do not add ad-hoc confirmation asks into the loop. Layer-2 outcome metrics (vs SPY buy-and-hold, Sharpe, drawdown) are read only at the weekly checkpoint and campaign end from the ledger snapshots — never report daily P&L as a signal.',
  ],
};
