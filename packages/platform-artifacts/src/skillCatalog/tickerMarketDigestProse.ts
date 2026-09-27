export const DIGEST_GATHER_CONTEXT_PROMPT = `Gather the evidence base for one ticker's market digest: recent daily price history, company reference details, and sourced news. Everything downstream composes from what you fetch here — fetch honestly, report gaps honestly, invent nothing.

Inputs (already in your task context):
- \`ticker\` — the symbol to digest (uppercase, e.g. AAPL).
- \`focus\` — an optional operator note steering what the digest should emphasize (may be absent).
- \`symbol\`, \`prevBar\` — the already-fetched previous-session bar for the ticker. \`prevBar[0]\` carries the bar fields (o/h/l/c/v and an epoch-millisecond timestamp t); its date part is the latest completed session.

Steps:

1. Price history. Fetch daily aggregate bars for the ticker covering roughly the 30 most recent trading sessions — a window of about 45 calendar days ending at the latest completed session (derive the end date from \`prevBar\`'s timestamp), ascending, split-adjusted. Each bar carries open/high/low/close/volume and an epoch-millisecond timestamp; convert timestamps to YYYY-MM-DD dates. Report the bars you actually received — if the provider returns fewer sessions (a new listing, a free-tier limit), pass along what came back and say so in \`dataNotes\`.

2. Company reference. Fetch the ticker's reference details: company name, primary exchange, market cap, and description. A missing field is null, never a guess — note absences in \`dataNotes\`.

3. News, from BOTH sources. Fetch recent news for the ticker from your market-data provider's news feed, AND run a keyword search on the ticker and the company name against your general news source (English, the last 14 days, newest first). Merge the two sets and dedupe — by URL first, then by near-identical titles. Keep at most 12 items, preferring those most relevant to the ticker (and to \`focus\` when it is set). EVERY kept item carries its real article URL exactly as the feed returned it — an item without a URL is dropped, never patched with an invented link. Copy title, source/publisher name, and publish timestamp verbatim; add a one-sentence \`summary\` only when the feed supplied descriptive text to base it on, else null.

4. Coverage honesty. \`dataNotes\` is one short paragraph naming what was fetched (how many bars, which news sources returned items) and every gap: an empty news search, missing market cap, a thinner-than-requested bar window. Specific and honest — the composer reads it to decide what the digest can and cannot claim.

If a tool you need is missing from your toolbox, exit via your blocked-signal naming the missing capability — do not fabricate data.

Output (submit_output):
{
  company: {
    name: string,                  // from reference details; fall back to the ticker only if the lookup failed (and say so in dataNotes)
    description: string | null,
    primaryExchange: string | null,
    marketCap: number | null
  },
  bars: [ { date: string, open: number, high: number, low: number, close: number, volume: number } ],   // oldest first
  news: [ { title: string, source: string, url: string, publishedAt: string, summary: string | null } ],
  dataNotes: string                // what was fetched and every gap, named honestly
}`;

export const DIGEST_COMPOSE_PROMPT = `Compose the typed market digest for the ticker — strictly from the fetched inputs. Every number in the digest must appear in, or derive arithmetically from, the fetched bars and reference data; every news item must come from the gathered set with its URL unchanged. No outside knowledge, no invented numbers, no patched links.

Inputs (already in your task context):
- \`ticker\`, \`focus\` — the run's subject and optional emphasis note.
- \`symbol\`, \`prevBar\` — the previous-session bar as fetched.
- \`company\`, \`bars\`, \`news\`, \`dataNotes\` — the gathered evidence base.

Derivations for \`digest.priceSummary\` (compute from \`bars\`, oldest first):
- \`lastClose\`: close of the latest bar.
- \`changePct1d\`: (lastClose − the prior bar's close) ÷ the prior bar's close × 100, rounded to 2 decimals. With only one bar, 0 — and say so in a watch item or the brief.
- \`high30d\` / \`low30d\`: the maximum high and minimum low across the bars.
- \`changePct30d\`: (lastClose − the first bar's close) ÷ the first bar's close × 100, rounded to 2 decimals.
- \`avgVolume30d\`: mean of the bars' volumes, rounded to whole shares.

Assemble the rest of \`digest\`:
- \`ticker\`: the run's ticker. \`companyName\`: from \`company.name\`. \`asOf\`: the latest bar's date. \`focus\`: echo the note, or null when absent.
- \`bars\`: date + close (+ volume) per fetched session, oldest first — the card draws its trend strip from these.
- \`news\`: up to 12 items from the gathered set, preferring those that plausibly moved or explain the price (and those matching \`focus\`). Keep title, source, url, and publishedAt verbatim. \`note\`: one sentence on why the item matters, grounded in the fetched data; null for plain coverage.
- \`watchItems\`: 1–6 concrete risks or things to watch. Each one cites a fetched number or a kept news item ("closed 4.1% below the 30-day high of 259.30", "earnings date flagged by <source>") — generic boilerplate ("markets may fluctuate") is not a watch item. Gaps named in \`dataNotes\` that limit the digest's confidence belong here too.
- \`brief\`: 3–6 sentences quoting the key numbers: what the price did over the window, what the news coverage says, what to watch next. When \`focus\` is set, address it explicitly.

Top-level output fields:
- \`brief\`: the SAME text as \`digest.brief\`.
- \`newsCount\`: digest.news.length.
- \`digestComposed\`: 1.

Output (submit_output):
{
  digest: { ... },        // the full typed digest — your output contract carries its exact schema
  brief: string,          // identical to digest.brief
  newsCount: number,
  digestComposed: 1
}`;
