import type { SkillBundleId, SkillBundleInput } from '@aflow/schemas';
import {
  ALPACA_ACCOUNT_READ_API_DEFINITION,
  ALPACA_MARKET_DATA_API_DEFINITION,
  ALPACA_PAPER_ORDERS_WRITE_API_DEFINITION,
  ALPACA_PAPER_KEY_ID,
  ALPACA_PAPER_SECRET_KEY,
} from './alpacaApiDefinitions.js';

const ALPACA_THESIS_LEDGER_SCHEMA_DOC = `# /portfolio/theses/ — the thesis ledger

The substrate for every process metric and for campaign-end synthesis. All
docs are JSON. The unit of decision, measurement, and learning is the
**thesis**, never the trade.

## Open thesis — \`/portfolio/theses/open/{thesisId}.json\`

\`\`\`json
{
  "thesisId": "<kebab-case, unique>",
  "openedTradingDay": "<YYYY-MM-DD>",
  "openedSlot": "morning | after_close",
  "instrument": "<ticker>",
  "direction": "long | short",
  "rationale": "<the observed setup, with numbers>",
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

An order proposed while the market was closed. Orders queued against a closed
market are never submitted — they are recorded as intentions and submitted by
the first cycle that runs with the market open, before that cycle's new
orders, under the client order id fixed here.

\`\`\`json
{
  "clientOrderId": "<{tradingDay}-{slot}-{thesisId}-open|close, from the proposing cycle>",
  "thesisId": "<thesisId>",
  "intent": "open | close",
  "symbol": "<ticker>",
  "side": "buy | sell",
  "qty": "...|null",
  "notional": "...|null",
  "proposedTradingDay": "<YYYY-MM-DD>",
  "proposedSlot": "morning | after_close",
  "expiresAfterTradingDay": "<YYYY-MM-DD — the thesis deadline; null for close intentions>"
}
\`\`\`

The doc is deleted when the intention is submitted or expires. A short entry
intention records its target \`notional\`; the submitting cycle derives
whole-share \`qty\` from a fresh price — the broker rejects fractional short
sales. An entry intention whose thesis deadline has passed is expired, never
submitted — its thesis resolves \`entry_failed\`. An entry intention is submittable only when
its open-thesis doc exists; one with no thesis doc behind it (a crashed cycle
that re-decided) is deleted unsubmitted. Close intentions never expire: a held
position must still be closed, and the settled close is patched onto its
resolved thesis doc.

## Resolved thesis — \`/portfolio/theses/resolved/{thesisId}.json\`

The full open-thesis doc plus:

\`\`\`json
{
  "outcome": "confirmed | falsified | expired | entry_failed",
  "entryFillState": "filled | partial | none",
  "resolvedTradingDay": "<YYYY-MM-DD>",
  "resolvedSlot": "morning | after_close",
  "resolutionEvidence": "<observed prices quoted against the written criterion; for entry_failed, the order-state facts>",
  "closeOrder": { "clientOrderId": "...", "orderId": "...|null", "disposition": "...", "statusCode": 200, "qty": "...|null", "fillState": "filled | partial | pending | null", "error": null }
}
\`\`\`

A thesis resolves exactly one way; the open doc is deleted when the resolved
doc is written. \`entryFillState\` is the explicit fill-truth assertion: only
a thesis whose entry FILLED (\`filled\` or \`partial\`) may resolve confirmed,
falsified, or expired; an unfilled / expired / cancelled / rejected entry
(\`none\`) resolves \`entry_failed\` with no closeOrder, no P&L attribution,
and no position narration — no position ever existed. A close deferred as an
intention is patched onto \`closeOrder\` when it settles — the resolved doc
always ends with the close truth. A resolved thesis whose close never filled
while its position is still held is repaired by the next cycle: resolution
lists it as a repair close (qty = the thesis's own filled entry quantity,
clamped to the held quantity), execution closes it before new entries, and the
settled close is patched here. Every learning cites a resolved thesis doc
via \`detailRef\`.

## Cycle doc — \`/portfolio/theses/cycles/{tradingDay}-{slot}.json\`

The idempotency marker: a cycle is complete exactly when its doc exists, and
it is written LAST — a crashed cycle re-runs, it is never half-recorded.

\`\`\`json
{
  "tradingDay": "<YYYY-MM-DD>",
  "slot": "morning | after_close",
  "coverageNote": "<missed slots since the last cycle, named honestly>",
  "thesesOpened": ["<thesisId>"],
  "thesesResolved": [{ "thesisId": "...", "outcome": "...", "statedConfidence": "..." }],
  "submittedCount": 2,
  "deferredCount": 0,
  "failedCount": 0,
  "projectedGrossExposurePct": 42.5,
  "decisionRationale": "<why these theses (or why none)>"
}
\`\`\`

## Snapshot — \`/portfolio/snapshots/{tradingDay}-{slot}.json\`

\`\`\`json
{ "equity": 100000, "cash": 60000, "positions": [ ... ], "brokerGrossExposurePct": 41, "grossExposurePct": 40, "orphanFlattens": [{ "symbol": "...", "qty": "...", "side": "long | short", "evidence": "..." }] }
\`\`\`

\`grossExposurePct\` is campaign-attributed (broker gross minus the
orphanFlattens' notionals) — the number scored against the campaign cap.
\`brokerGrossExposurePct\` is the raw broker truth, orphans included.
This account is the agent's alone to manage: any broker position that no open
thesis, pending close intention, or resolved-but-unclosed thesis (repair close)
accounts for is an ORPHAN, and every orphan is reconciled — flattened this cycle
back to a state where every position carries a thesis. \`orphanFlattens\` records
what was cleared, with the provenance evidence, so a surprising flatten is
auditable. There is no operator-owned position in this account to leave alone.

## Market-data cache — \`/portfolio/market-data/{symbol}.json\`

\`\`\`json
{ "symbol": "SPY", "bars": [ { "t": "<YYYY-MM-DD>", "o": 0, "h": 0, "l": 0, "c": 0, "v": 0 } ] }
\`\`\`

The local price-history layer: every cycle reads this doc BEFORE calling the
market-data feed, fetches only the days it lacks, and upserts it keeping the
most recent 30 daily bars (oldest dropped, newest last).
Only COMPLETED sessions enter the cache — the clock date's bar is still
forming while the market is open, and caching it would freeze a partial bar
as that day's permanent record, corrupting every resolution that later reads
it. Prices cited in criteria resolutions and rationales come from this cache
or a fresh fetch — never from prose in earlier ledger docs.

## How the metrics derive (two layers, never conflated)

**Layer 1 — process (fast, per cycle, the primary signal):**
- Cycle reliability: cycle docs vs the SCHEDULED (tradingDay, slot) grid —
  exactly two slots per trading day (morning, after_close); gaps are named in
  the next cycle's \`coverageNote\`, and no slot outside the schedule counts
  as missed.
- Thesis discipline: every order in every cycle doc carries a \`thesisId\`.
- Resolution rate: resolved docs vs deadlines; an unresolved-past-deadline
  thesis is a process defect.
- Fill discipline: entry orders resolve to a fill state the same cycle they
  are submitted; \`entry_failed\` resolutions and expired intentions are
  counted, never narrated as trades.
- Calibration: \`statedConfidence\` vs \`outcome\` across resolved docs of
  FILLED trades only — an \`entry_failed\` resolution carries no market
  evidence and is excluded from calibration.
- Loop health: learnings per resolution ≤ 1, each with a resolved-doc
  \`detailRef\`.
- Exposure discipline: each snapshot's thesis-attributed \`grossExposurePct\`
  vs the campaign cap — the cross-check on the previous cycle's projection;
  the raw \`brokerGrossExposurePct\` stays alongside.

**Layer 2 — outcome (slow, windowed — read ONLY at the weekly checkpoint and
campaign end):** portfolio equity series (from snapshots) vs SPY buy-and-hold
on identical capital over the campaign window; Sharpe + max drawdown over the
same window. Raw daily P&L is not a signal anywhere.
`;

export const ALPACA_THESIS_TRADING: SkillBundleInput = {
  bundleId: 'alpaca-thesis-trading' as SkillBundleId,
  version: 3,
  name: 'Alpaca Thesis Trading',
  tagline:
    'Thesis-driven semi-daily paper trading: chained campaigns, structural risk caps, a falsification ledger.',
  description: `Wires up the **Alpaca paper API** (account read, market data, order write) and the **Daily Trading Cycle** skill — long-horizon autonomy on a paper account where the unit of decision, measurement, and learning is the **thesis**: instrument + direction + rationale + falsification criterion + confirmation criterion + deadline + size, written and validated before any order exists.

**What you get**:
- The three Alpaca API definitions + default bindings (one set of paper credentials serves all three).
- The **Daily Trading Cycle** skill — one run per (tradingDay, slot): resolve every open thesis against its written criteria, propose new theses under the campaign's frozen regime, execute orders (closes then entries, idempotent client order ids), record everything to the thesis ledger under \`/portfolio/theses/\`.
- The thesis-ledger schema doc — the contract every process metric derives from.

**No human gate**: paper trading carries zero financial risk; the safety layer is the structural risk-gate — campaign caps (universe, theses/day, per-position %, gross exposure, horizon bounds) are bound into the decide task's output contract and violations are rejected by schema validation.

**After install**:
1. Add your Alpaca paper API key id + secret in Integrations (one credential pair, reused by all three bindings).
2. Start a campaign: regime name, ONE prose hypothesis, universe, caps, horizon bounds, and the pre-registered evaluation window. The regime is frozen mid-campaign — strategy evolves at campaign boundaries.
3. Create the two cron schedules that fire the cycle: one shortly AFTER the open (~09:35 exchange time — orders submit only while the market is open) and one after the close. Missed slots self-heal: the next cycle resolves everything pending and records the gap honestly.`,
  tags: ['alpaca', 'paper-trading', 'theses', 'campaigns', 'autonomy'],
  skillCatalogIds: ['daily-trading-cycle'],
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
        'Thesis-ledger contract: thesis / cycle / snapshot doc shapes and how the two metric layers derive from them.',
      seedPolicy: 'skip' as const,
    },
  ],
  helmsmanHints: [
    'Add the Alpaca paper API key id + secret in Integrations before running — one credential pair serves the account-read, market-data, and orders-write bindings.',
    'To run the Daily Trading Cycle, call workflow.run.start({ slug }). The first run rejects with CAMPAIGN_REQUIRED carrying the contract fields (regime name, hypothesis, universe, theses/day cap, per-position and gross-exposure caps, horizon bounds, evaluation window) — collect them once and re-issue workflow.run.start({ slug, campaignConfig: { … } }).',
    'The campaign regime is FROZEN mid-window — pre-registration is what makes the windowed evaluation honest. To change strategy, end the campaign and start the next one; vetted learnings carry across.',
    'Set up two cron schedules (action start_run, no input template needed): one shortly AFTER the exchange open (~09:35 exchange time) and one after the close. Orders submit only while the market is open — a closed-market cycle defers its orders as intentions that the next open-market cycle submits first. Runs are idempotent per (tradingDay, slot) and self-heal missed slots, so an overdue firing on stack startup is safe.',
    'There is no human approval gate on orders: paper trading carries zero financial risk and the campaign caps are enforced structurally in the decide contract. Do not add ad-hoc confirmation asks into the loop.',
    'Layer-2 outcome metrics (vs SPY buy-and-hold, Sharpe, drawdown) are read only at the weekly checkpoint and campaign end from the ledger snapshots — never report daily P&L as a signal.',
  ],
};
