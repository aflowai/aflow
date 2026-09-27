export const BRIEF_GATHER_PROMPT = `Gather the evidence base for a research brief on one question: find the most relevant, most authoritative pages on the open web, read them, and pull out what they actually say. Everything downstream composes from what you fetch here — fetch honestly, report gaps honestly, invent nothing.

Inputs (already in your task context):
- \`question\` — the topic or question to research.
- \`focus\` — an optional operator note narrowing the angle or adding a constraint (may be absent).

Steps:

1. Search. Search the web for the question, and — when the question is time-sensitive ("latest", "recent", a current event) — also run a news search so fresh coverage is in the mix. Read the hits: their titles, urls, and snippets. Widen or re-phrase and search again if the first pass is thin or off-target. Judge the hits for relevance to the question (and to \`focus\` when set) and for authority — prefer primary sources, official pages, and established publications over aggregators and SEO filler.

2. Select and fetch. Pick the handful of results (roughly 3–6) most worth reading in full, and fetch each chosen page's content as markdown. Read what came back. If a page is thin, paywalled, or off-topic once fetched, drop it and fetch another hit instead — do not pad the brief with a source you did not actually read.

3. Extract findings. From the fetched pages — not from the search snippets, and not from your own prior knowledge — pull the load-bearing findings that answer the question. EVERY finding names the exact page URL it came from; a claim you cannot point at a fetched page for does not go in. Keep the source's specifics (numbers, dates, names, direct points) in the detail, not a vague paraphrase.

4. Sources and coverage. List every page you fetched and used, with its title and url, deduped. Then write one short paragraph on coverage: how well the fetched pages answer the question, and every gap — a thin or conflicting result set, a paywalled page you could not read, a source that turned out stale. Specific and honest — the composer reads it to decide what the brief can and cannot claim.

If a tool you need is missing from your toolbox, exit via your blocked-signal naming the missing capability — do not fabricate results.

Output (submit_output):
{
  findings: [ { claim: string, detail: string, sourceUrl: string, sourceTitle: string } ],   // every finding traces to a fetched page URL
  sources: [ { url: string, title: string } ],                                               // every page fetched and used, deduped
  coverageNote: string                                                                       // how well the sources cover the question, and every gap
}`;

export const BRIEF_COMPOSE_PROMPT = `Compose the typed research brief for the question — strictly from the gathered findings. Every claim in the brief must come from the gathered set with its source URL unchanged; no outside knowledge, no invented facts, no patched links. Your job is synthesis and honest framing, not new research.

Inputs (already in your task context):
- \`question\`, \`focus\` — the question and optional angle.
- \`findings\`, \`sources\`, \`coverageNote\` — the gathered evidence base.

Assemble \`digest\`:
- \`title\`: a concise title naming what the brief answers.
- \`summary\`: 3–8 sentences answering the question, weaving the findings into a direct answer. Address \`focus\` explicitly when it is set. Every claim here rests on a gathered finding — if the sources disagree or fall short, say so rather than resolving it yourself.
- \`findings\`: the load-bearing claims, each with its \`claim\`, the supporting \`detail\`, and the \`sourceUrl\` + \`sourceTitle\` it traces to — copied verbatim from the gathered set. Drop nothing's source; a finding without a real URL cannot be included.
- \`openQuestions\`: what the fetched sources did not resolve — the honest gaps the reader should know the brief does not cover. Draw these from the coverage note and from where the findings ran out.
- \`sources\`: the deduped bibliography — every page used, url + title.
- \`coverageNote\`: how well the sources cover the question and every gap, grounded in what \`coverageNote\` reported.

Top-level output fields:
- \`brief\`: the SAME text as \`digest.summary\`.
- \`sourceCount\`: digest.sources.length.
- \`briefComposed\`: 1.

Output (submit_output):
{
  digest: { ... },        // the full typed brief — your output contract carries its exact schema
  brief: string,          // identical to digest.summary
  sourceCount: number,
  briefComposed: 1
}`;
