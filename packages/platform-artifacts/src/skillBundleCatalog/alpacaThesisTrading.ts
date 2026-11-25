import type { AuthoredSkillBundle } from '../skillBundleCatalog.js';
import { DESK_TALLY_RULE } from '../skillCatalog/strategyDeskTally.js';
import { PERFORMANCE_REVIEW_SCHEDULES } from '../skillCatalog/performanceReview.js';
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
slot, and every one of them resolves, decides, executes and records:

- \`pre_market\` — before the open. It sees no price of the session, so it
  resolves only on order facts (\`entry_failed\`). The theses it decides wait
  as intentions for the open.
- \`open\` — shortly after the open.
- \`intraday\` — the hourly firings while the market is open, numbered by
  \`slotIndex\` from 1.
- \`after_close\` — after the close. It resolves on the close and writes the
  close report. The theses it decides wait as intentions for the next open.

\`{slotKey}\` in ledger paths and client order ids is the slot, or
\`intraday-{slotIndex}\` on an intraday cycle (e.g. \`2026-07-14-intraday-3\`).
Every ledger doc carries the slot name and its index (null outside intraday).

## Hypothesis arms

A campaign tests several named hypotheses side by side, one arm each. Its
\`hypotheses\` field gives each an \`id\`, a \`name\` and a \`statement\`.
Every thesis cites its arm in \`hypothesisId\`. Every thesis doc names its
campaign in \`regimeName\` and its arm in \`hypothesisId\`, and the record
contract refuses a live thesis doc without \`thesisId\`, \`regimeName\` or
\`hypothesisId\`, so no thesis drops out of a count.

## Campaign start archive — \`/portfolio/archive/theses/{stamp}-{regimeName}/\`

The live ledger holds one campaign's docs. When \`workflow.campaign.start\`
creates a campaign, it first moves every doc under \`/portfolio/theses/open/\`
and \`/portfolio/theses/resolved/\` to \`open/\` and \`resolved/\` below one
archive folder, in one pass. That covers docs of every earlier campaign and
docs from before hypothesis arms. Their content is untouched, and the start
output lists every move in \`migrations\`. The start is refused while another
campaign of a skill that keeps this ledger is active. The next open cycle
flattens a position whose thesis was archived as an orphan, and expires an
entry intention whose thesis doc is gone. A learning keeps the \`detailRef\`
it was written with, and the archived doc keeps its file name. Never write
to the archive.

## Approved set — \`/research/{tradingDay}/approved-theses.json\`

One set per trading day. The **Strategy Desk** writes it: its strategist
proposes candidates, seven review lenses each give a candidate approved or
rejected with a reason, and a desk reviewer reads every finding and may veto
a candidate with a stated reason. The set keeps all of it:

\`\`\`json
{
  "tradingDay": "<YYYY-MM-DD>",
  "reviewRunId": "<the desk run that wrote the set, or the operator's own review label>",
  "candidates": [
    { "candidateId": "<kebab-case>", "instrument": "<ticker>", "direction": "long | short", "hypothesisId": "<a campaign arm>", "entryLevel": 187.4, "invalidationLevel": 184.0, "confirmationLevel": 195.0, "sizePct": 5, "horizonTradingDays": 3, "hypothesis": "...", "evidence": [ ... ] }
  ],
  "lenses": { "<lens>": [{ "candidateId": "...", "verdict": "approved | rejected", "reason": "<the lens's own words>" }] },
  "vetoes": [{ "candidateId": "...", "by": "desk | <lens>", "reason": "..." }]
}
\`\`\`

${DESK_TALLY_RULE} The tally is computed by code wherever the set is read, so
no writer records a verdict. A set the operator writes needs only
\`tradingDay\`, \`reviewRunId\` and candidates with an instrument, a
direction and an arm.

A desk run that runs again replaces the set with its own view of the day. Its
strategist reads the current set and carries forward what still holds. A
cycle reads the set as it stands when it decides. A cycle whose schedule
passes \`bindingId\` and finds no set for its day runs the desk first and
waits for it.

A thesis instantiates an approved candidate by its \`approvedId\` and keeps
the candidate's instrument, direction and arm. Each approved candidate opens
one thesis a day. Its size, timing, levels and deadline are the decision's.

The decide contract accepts the set only from the operator, through Memory or
the API, or from a task of one completed desk run of this space, the run the
set names in \`reviewRunId\`. A set any Daily Trading Cycle run or agent
conversation wrote is refused. A refused set opens nothing and stops nothing
else, and the cycle doc names the fault in \`approvedSetFault\`.

Each desk run records how it ended at
\`/research/{tradingDay}/desk-runs/{runId}.json\`, with every lens summary
and the desk reviewer's summary. Its research memo is at
\`/research/{tradingDay}/strategy-memo-{runId}.md\`.

## Market regime — gathered every cycle, read as information

After resolution, every cycle reads the daily bars of SPY, QQQ and IWM, and
those of every universe member, through the \`${REGIME_READ_BINDING_ID}\` binding.
The platform computes the market regime from those two reads and the exchange
clock, by rule. It takes the last ${String(INDEX_LOOKBACK_SESSIONS)} completed daily closes of SPY, QQQ and
IWM from the index read, and the last ${String(MEMBER_LOOKBACK_SESSIONS)} of every universe member from the
universe read. No model reads, copies or computes a close. From them it gives:

- each index's close, 20-day and 50-day average, whether it closes above each,
  and its realized volatility.
- \`realizedVolPct\` — SPY's realized volatility.
- \`breadth\` — the members above their 20-day average, of the members the
  read holds 20 sessions of, and the share. A member with fewer is named in
  \`thinMembers\` and left out.
- \`state\` — risk_on, mixed, risk_off or stressed.

${REGIME_MATH_RULE}. The state: ${REGIME_STATE_RULE}. ${AS_OF_RULE}. ${SESSION_COMPLETED_RULE}.
${INDEX_SERIES_RULE}. ${MEMBER_SERIES_RULE}.

decide reads the regime. It gates nothing: a cycle whose regime could not be
gathered names the state \`unavailable\` and decides as on any other cycle.

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
  "approvedId": "<the approved candidate it instantiates>",
  "entryLevel": "<the level it enters at>",
  "invalidationLevel": "<the level it is wrong at: the risk at entry>",
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
  "entryOrder": { "clientOrderId": "...", "orderId": "...|null", "disposition": "submitted | duplicate | deferred | expired | failed", "statusCode": 200, "fillState": "filled | partial | pending | null", "qty": "...|null", "notional": "...|null", "shortSizing": "whole_share | fractional | whole_share_capability_unknown | null", "failureSource": "broker_rejected | sizing_rule | not_submitted | null", "error": null },
  "status": "open | entry_pending | entry_failed"
}
\`\`\`

The doc lands after order execution, but every field except \`entryOrder\` is
fixed by the decision output that preceded the order — the thesis is
pre-registered by construction. A thesis whose orders were deferred as an
intention carries \`status: "entry_pending"\` until the intention is submitted;
a failed or expired entry is written with \`status: "entry_failed"\` and its
\`error\` and \`failureSource\` on it — a failed entry is evidence.

\`entryOrder\` is the entry's order result, copied whole. \`shortSizing\` names
the rule that sized a submitted or failed short entry, and is null otherwise.
\`whole_share\` sent whole shares. \`fractional\` sent a qty under one share,
only where whole shares sized it to 0 and the account's
\`fractional_trading\` was true. \`whole_share_capability_unknown\` sent whole
shares where the account configuration omitted \`fractional_trading\`, and so records
that the capability was unknown. \`failureSource\` says why a failed entry
failed, and is null on every other. \`broker_rejected\` means the broker
refused a sent order. \`sizing_rule\` means the sizing rule gave a qty the
broker cannot take, such as 0 shares, and sent nothing. \`not_submitted\`
means it was not sent for another reason. Only \`broker_rejected\` is a broker
rejection.

## Deferred intention — \`/portfolio/intentions/{clientOrderId}.json\`

An order decided while the market was closed, or with an entry condition not
yet met. An order is sent only while the market is open, so it waits here. The first open-market cycle that
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
\`qty\` from a fresh price in whole shares. Only where that rounds down to 0
shares and the account's \`fractional_trading\` is true does it send a
fractional \`qty\` under one share. An entry intention whose thesis deadline
has passed is expired, never submitted — its thesis resolves \`entry_failed\`. An entry intention is submittable only when
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
  "entryFillPrice": "<the entry order's filled average price, kept so a close that settles later can compute realizedR. null on entry_failed>",
  "realizedR": "<the realized return over the risk at entry, from entryFillPrice, the close fill and the invalidationLevel. null on entry_failed or until the close fills>",
  "closeOrder": { "clientOrderId": "...", "orderId": "...|null", "disposition": "...", "statusCode": 200, "qty": "...|null", "fillState": "filled | partial | pending | null", "filledAvgPrice": "<number, or null>", "error": null }
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
  "openedApprovals": [{ "thesisId": "...", "approvedId": "..." }],
  "approvedSetFault": "<why the approved set approved nothing — unreadable, unparsable or a refused writer — or null>",
  "thesesResolved": [{ "thesisId": "...", "hypothesisId": "<the arm its ledger doc names>", "outcome": "...", "entryFillPrice": "<number, or null>", "realizedR": "<number, or null>", "statedConfidence": "..." }],
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
when the regime could not be gathered. \`bias\` is null when decide produced no
decision, and \`decisionFault\` says why.
\`preMarketNote\` is the path of the note decide read. It is null when the day
has no note, and \`preMarketFault\` is then null too. It is null when the read
failed, and \`preMarketFault\` then holds the failure. A failed read leaves
decide without the evidence, and the cycle still decides, closes, records and
completes.

## Snapshot — \`/portfolio/snapshots/{tradingDay}-{slotKey}.json\`

\`\`\`json
{ "equity": 100000, "cash": 60000, "positions": [ ... ], "brokerGrossExposurePct": 41, "grossExposurePct": 40, "orphanFlattens": [{ "symbol": "...", "qty": "...", "side": "long | short", "evidence": "..." }], "armTable": null, "benchmarkClose": null, "marketState": "...", "marketRegime": { ... }, "calendar": null }
\`\`\`

\`benchmarkClose\` is SPY's close on an after_close tradingDay, copied from the
bar that confirmed the day, and null on every other slot. The Layer 2
benchmark reads it. A null on after_close is a measurement gap, never an
estimate.

\`marketState\`, \`marketRegime\` and \`calendar\` are the cycle's, the same values
the cycle doc holds. The after_close snapshot shows the regime at the close of
the day.

\`grossExposurePct\` is campaign-attributed (broker gross minus the
orphanFlattens' notionals).
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
entry here. It reads the trading day from the exchange clock and calendar,
so a run on a weekend or a market holiday reflects on the session that
closed last, and a day with no session gets no entry. A session the journal
already holds, here or in the folder, settles \`already_reflected\` and
gets no second entry in either journal. It writes the
same entry to \`journal/{tradingDay}.md\` in the connected folder, creating
\`journal/\` where the folder has none. A folder copy that fails settles the
reflection as \`folder_unwritten\`. The desk reads the journal
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
it. The process metrics are the theses formed and resolved over the day,
\`grossExposurePct\`, the \`marketState\` and the faults the after_close cycle
doc names. The two counts are the lengths of the day's
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

## Goals and principles — \`strategy/goals.md\` and \`strategy/principles.md\` in the folder

The **Desk Charter** skill writes both files to the connected folder, once its
reviewer approves the drafts. goals.md pre-registers what success means per
window and per quarter in both layers. principles.md says what the desk never
does whatever the thesis. Each skill that reads them takes \`goalsPath\` and
\`principlesPath\` where they live elsewhere.

## Review doc — \`/strategy/reviews/{periodStart}-to-{periodEnd}.md\`

The **Performance Review** skill writes one per period, weekly after the
Friday close and at the window boundary, once its reviewer has checked the
verdict. It holds Layer 1 for the period and Layer 2 for the window, the
per-arm table, each goal on or off track, each principle breach with its
citations, every measurement gap, and the correction with its citations. Only
an approved correction is applied: a halt ends the campaign at once. A
boundary correction goes to the **Campaign Successor**, and only a draft every
lens approved ends the campaign and starts as its successor.

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
  every opened thesis carries the \`approvedId\` it was approved under.
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
- Review lenses: every opened thesis carries its \`approvedId\`, and the day's
  set keeps what each lens said on that candidate. Joined by approvedId, each
  lens's rejection rate can be set against the falsification rate of the
  theses the tally approved over it, read over the window.
- Exposure: each snapshot's thesis-attributed \`grossExposurePct\` — the
  cross-check on the previous cycle's projection; the raw
  \`brokerGrossExposurePct\` stays alongside.

**Layer 2 — outcome (slow, windowed — read ONLY at the weekly checkpoint and
campaign end):** portfolio equity series (from snapshots) vs SPY buy-and-hold
on identical capital over the campaign window, from each snapshot's
\`benchmarkClose\`. Sharpe + max drawdown over the same window. Each arm's
expectancy in R from the \`realizedR\` of its filled resolutions. A field the
ledger lacks is a measurement gap, never an estimate.
Raw daily P&L is not a signal anywhere.

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
  revision: 14,
  name: 'Alpaca Thesis Trading',
  tagline:
    'Thesis-driven paper trading: the strategy defines a trade, a desk reviews candidates, the agent decides and executes.',
  description: `Wires up the **Alpaca paper API** (account read, market data, order write), the **Daily Trading Cycle** skill, the **Strategy Desk** skill that writes the day's approved set, the **Trading Reflection** skill that writes the journal after the close, the **Campaign Successor** skill that drafts the next campaign at a boundary, the **Desk Charter** skill that writes the desk's goals and principles, and the **Performance Review** skill that reviews each period. The unit of decision, measurement and learning is the **thesis**: hypothesis arm + instrument + direction + rationale + falsification criterion + confirmation criterion + deadline + size, written before any order exists.

**The strategy defines, the agent decides and executes**: the campaign defines what a trade is — its arms, its universe and its horizon bounds. The desk reviews candidates to catch mistakes. The cycle's agent decides which approved candidates to trade, when and how much, and executes. The contracts hold only what the strategy defines, what the broker requires and what the account can express: price, the whole-share floor, \`fractional_trading\` and equity.

**What you get**:
- The three Alpaca API definitions + default bindings (one set of paper credentials serves all three).
- The **Daily Trading Cycle** skill — one run per (tradingDay, slot): resolve every open thesis against its written criteria, read the day's approved set (running the desk first where the day has none), decide and execute new theses, record everything to the thesis ledger under \`/portfolio/theses/\`. Every slot may act. An order the market cannot take now waits as an intention for the next open-market cycle. The \`after_close\` cycle also writes the close report at \`${CLOSE_REPORT_PATH_TEMPLATE}\`, a record only that no desk reads.
- The **Strategy Desk** skill — one review pass per run. A strategist on the machine’s coding agent proposes candidates, seven lenses review them side by side, and a desk reviewer may veto one with a stated reason. ${DESK_TALLY_RULE} The set keeps every finding.
- The **Trading Reflection** skill — one run after the close. An analyst on the coding agent writes the journal entry the desk reads next.
- The **Campaign Successor** skill — one run at a campaign boundary. A strategist drafts the successor campaign's contract, and six lenses review it.
- The **Desk Charter** skill — one run, or one when the plan changes. It drafts goals.md and principles.md for the folder.
- The **Performance Review** skill — weekly after the Friday close and once at the window boundary.
- The thesis-ledger schema doc — the contract every process metric derives from.

**Market regime, as information**: every cycle computes the regime by rule from the market-data binding: SPY, QQQ and IWM against their 20-day and 50-day averages, SPY's realized volatility, and the breadth of the universe members with enough sessions. decide reads it, and it gates nothing.

**After install**:
1. Add your Alpaca paper API key id + secret in Integrations (one credential pair, reused by all three bindings).
2. Start a campaign with workflow.campaign.start: regime name, the hypotheses it tests (each with an id, a name and a statement), the universe, the horizon bounds, the pre-registered evaluation window, and the boundary rules (pooled sample floor, expectancy floor in R, calibration rule). The campaign is frozen mid-window. The start moves every thesis doc of an earlier campaign to /portfolio/archive/theses/ in one pass and lists each move.
3. Connect the folder that holds the desk’s journals and strategy records. Then create the cycle schedules, in exchange time (America/New_York), weekdays, staggered off round boundaries. Each passes \`{ slot, bindingId }\`, with the folder's binding id, and names no date:
   - a **pre-market** firing (e.g. 08:47) with \`slot: "pre_market"\`.
   - an **open** firing (e.g. 09:37) with \`slot: "open"\`.
   - **hourly intraday** firings (e.g. 10:07 through 15:07) with \`slot: "intraday"\`, numbered by the hour of the session from the 09:30 open (10:07 is \`intraday-1\`).
   - an **after-close** firing (e.g. 16:23) with \`slot: "after_close"\`.

   The first cycle of a day that finds no set runs the Strategy Desk and waits for it, then decides from the set it wrote. To refresh the set on new information, schedule the desk with \`{ bindingId, tradingDay: { "$now": "date" } }\` at any time. Missed slots self-heal: the next cycle resolves everything pending and records the gap.

   After the close, the Helmsman's after-close schedule (e.g. 16:45) starts the **Trading Reflection** with \`{ bindingId }\`. Its analyst writes the journal entry the desk reads, and the Helmsman writes no reflection itself.
4. Run the **Desk Charter** once with \`{ bindingId }\`, so the principles lens and the reviews read the goals and principles. The Helmsman's weekly schedule after the Friday close starts the **Performance Review** with \`{ bindingId, kind: "weekly", periodStart, periodEnd }\`, and a one-time schedule after the window's last session starts it with \`kind: "boundary"\` and \`attempt: 1\`.
5. To steer what the desk proposes, keep journals, strategy records and boundary rules in the folder, and notes under \`/research/notes/\` in Memory. The campaign is the operator's: it changes at a boundary.
6. Optional: write the day's research note to \`/research/{tradingDay}/pre-market.md\`. decide reads its first ${String(PRE_MARKET_EVIDENCE_MAX_CHARS)} characters as evidence.
7. Optional: bind a calendar source, an API definition \`${CALENDAR_SOURCE_API_ID}\` with a \`${CALENDAR_SOURCE_ENDPOINT_ID}\` endpoint shaped as \`/portfolio/theses/SCHEMA.md\` says.`,
  tags: ['alpaca', 'paper-trading', 'theses', 'campaigns', 'autonomy'],
  skillCatalogIds: [
    'daily-trading-cycle',
    'strategy-desk',
    'trading-reflection',
    'campaign-successor',
    'desk-charter',
    'performance-review',
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
        'Order submission (POST) and cancellation (DELETE). Granted to exactly one task (execute-orders), whose inputs are the decided theses and resolutions — every order carries a thesis written before it.',
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
        'Thesis-ledger contract: approved set, thesis, cycle and snapshot doc shapes, and how the two metric layers derive from them.',
      // The platform's own contract, not an operator doc: an update must
      // deliver the approved-set shape the cycle now reads.
      seedPolicy: 'overwrite' as const,
    },
  ],
  helmsmanHints: [
    'Add the Alpaca paper key id + secret in Integrations: one pair serves all three bindings.',
    'To run the Daily Trading Cycle, call workflow.run.start({ slug }). The first run rejects with CAMPAIGN_REQUIRED carrying the contract fields: regime name, hypotheses { id, name, statement }, universe, horizon bounds, evaluation window, pooled sample floor, expectancy floor in R and calibration rule. Collect them once and call workflow.campaign.start({ slug, config: { … } }), then re-issue workflow.run.start({ slug }). Tell the operator what the start archived.',
    'Set up the cron schedules in America/New_York on weekdays, staggered off round boundaries: pre-market (e.g. 47 8 * * 1-5), open (37 9 * * 1-5), hourly intraday (7 10-15 * * 1-5) and after-close (23 16 * * 1-5). Each input asks for workflow.run.start({ slug, inputs: { slot, bindingId } }) with the folder’s binding id. Name no date: the clock gives the day.',
    'A cycle that finds no approved set for its day runs the Strategy Desk with its bindingId and waits for it. To refresh the set on new information, start strategy-desk with { bindingId, tradingDay: { "$now": "date" } }. If no thesis opens, read the desk records under /research/{tradingDay}/desk-runs/ and the cycle doc’s decisionRationale.',
    'Your after-close schedule (e.g. 45 16 * * 1-5) starts trading-reflection with { bindingId } alone: the clock gives the day. Report its tradingDay and reflectionOutcome, and write no reflection: its analyst writes the entry.',
    'The campaign is the operator’s, frozen mid-window. Act on each performance-review nextStep. retry: run it again within the hour with attempt: nextAttempt. helmsman_hand_over: end the campaign if still active, then workflow.campaign.start with draftConfig unchanged. After either hand-over, schedule the successor’s boundary review. A start refused while a review runs: start it again once that run ends.',
    'The cycle reads fractional_trading from the account configuration, through the get_account_configurations endpoint of alpaca-account-read. A cycle that fails at ingest-account-config because the stored definition declares no such endpoint needs the bundle updated through Store → Update. Installing the bundle again keeps the stored definition.',
    'Orders have no human gate on this paper account. Only performance-review reads Layer-2 metrics (vs SPY buy-and-hold, Sharpe, drawdown), and daily P&L is no signal. Send every review report verbatim with channel.message.send where a channel is set up. Start desk-charter once with { bindingId } where the folder lacks goals or principles.',
    `${PERFORMANCE_REVIEW_SCHEDULES.weekly} ${PERFORMANCE_REVIEW_SCHEDULES.boundary}`,
  ],
};
