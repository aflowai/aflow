export const SCAN_GATHER_PROMPT = `Gather the paper base for a literature scan on one topic: find the most relevant and most influential papers across the academic sources, read their metadata, and pull out what each one actually contributes. Everything downstream composes from what you gather here — gather honestly, report gaps honestly, invent nothing.

Inputs (already in your task context):
- \`topic\` — the research topic or question to survey.
- \`focus\` — an optional operator note narrowing the angle (a subfield, "recent work", a specific method); may be absent.

The sources, and when to reach for each:
- arXiv — preprints in computer science, physics, math, quantitative biology and related fields. Best for cutting-edge and recent work. Returns normalized JSON paper records — totalResults plus papers[], each with the arxivId, title, authors, abstract, categories, and abstract/PDF links. Start with max_results=10 and never request more than 15 in one query; page (start offset) or issue another query only after inspecting the first batch and finding a real coverage gap.
- Semantic Scholar — a cross-domain academic graph with abstracts and citation counts. Best for finding influential/highly-cited work and for judging impact; you can also walk the papers that cite a given paper. Returns JSON. Request only the fields you need (title, authors, year, venue, abstract, citationCount). It can still return HTTP 429 under load — page politely and back off.
- PubMed — the biomedical and life-sciences literature. Best when the topic is medical, clinical, or biological. Two steps: search the topic for matching ids, then fetch summaries for those ids (title, authors, journal, date). Returns JSON.

Judge the topic and \`focus\` to decide which sources are relevant — not every topic needs all three (a CS topic may not touch PubMed; a clinical topic leans on PubMed and Semantic Scholar). Search the sources you judge relevant, and say in the coverage note which you used and which you deliberately skipped.

If a source rate-limits you (an HTTP 429), do not hammer it — you have no way to wait it out. Retry that one call at most once or twice, spaced apart; if it still fails, move on and finish the scan with the papers you already have, naming the shortfall plainly in the coverage note (e.g. a source that throttled you before citation counts came back). Keep your request count low from the start: prefer a few broad searches over many narrow ones, and request only the fields you need, so you gather what you need before any limit bites.

Steps:

1. Search. For each relevant source, search the topic (and \`focus\` when set). Read the hits: titles, authors, years, venues, abstracts/summaries, and — from Semantic Scholar — citation counts. Widen, re-phrase, or add a source if the first pass is thin or off-target.

2. Select. Pick the papers most worth including — the most relevant to the topic, and the most influential (highly-cited, or seminal, or the clear recent state-of-the-art). Aim for a focused set (roughly 6–15) that genuinely covers the topic rather than a long undifferentiated list. Prefer a spread across the relevant sources when the topic spans domains.

3. Gather metadata. For each selected paper record its title, authors, year, venue (when the source gives one), and a citation count ONLY when the source reported one — never invent a count. Capture the abstract/summary well enough to write its key point. EVERY paper carries a real source URL: an arXiv abstract link, a Semantic Scholar paper URL, or a PubMed link. A paper you cannot point at a real URL for does not go in — never invent a paper, a URL, or a citation count.

4. Coverage. Write one short paragraph on coverage: which sources you searched (and which you skipped and why), how well the gathered papers cover the topic, and every gap — a thin result set, a source that returned nothing, a subfield left uncovered, a rate-limit that cut a search short. Specific and honest — the composer reads it to decide what the scan can and cannot claim.

If a tool you need is missing from your toolbox, exit via your blocked-signal naming the missing capability — do not fabricate results.

Output (submit_output):
{
  papers: [ { title, authors: string[], year, venue?, url, citationCount?, source, keyPoint } ],  // every paper traces to a real source URL; source ∈ arxiv|semantic_scholar|pubmed
  coverageNote: string                                                                             // which sources searched, how well they cover the topic, and every gap
}`;

export const SCAN_COMPOSE_PROMPT = `Compose the typed literature scan for the topic — strictly from the gathered papers. Every paper in the scan comes from the gathered set with its metadata and URL unchanged; no outside knowledge, no invented papers, no patched links or citation counts. Your job is synthesis and honest framing, not new searching.

Inputs (already in your task context):
- \`topic\`, \`focus\` — the topic and optional angle.
- \`papers\`, \`coverageNote\` — the gathered paper base.

Assemble \`scan\`:
- \`topic\`: the topic the scan surveys (address \`focus\` when it was set).
- \`summary\`: 4–10 sentences synthesizing what the literature says about the topic — the main lines of work, where they agree, where they are contested, and which papers are seminal or the current state-of-the-art. Every claim rests on a gathered paper; if the papers disagree or fall short, say so rather than resolving it yourself.
- \`papers\`: the papers the scan rests on, each with its \`title\`, \`authors\`, \`year\`, \`venue\` (when present), \`url\`, \`citationCount\` (only when the source reported one), \`source\`, and a \`keyPoint\` — what it contributes. Copy the metadata and URL verbatim from the gathered set. A paper without a real URL cannot be included.
- \`themes\`: the themes or clusters the papers group into — how the literature organizes around the topic. Name each and say which papers sit in it.
- \`gaps\`: the open gaps the literature does not resolve — questions the gathered papers leave unanswered. Draw these from the coverage note and from where the papers ran out.
- \`coverageNote\`: which sources were searched, how well the papers cover the topic, and every gap — grounded in what \`coverageNote\` reported.

Top-level output fields:
- \`brief\`: a one-to-three-sentence headline answer to the topic, drawn from \`scan.summary\`.
- \`paperCount\`: scan.papers.length.
- \`scanComposed\`: 1.

Output (submit_output):
{
  scan: { ... },          // the full typed scan — your output contract carries its exact schema
  brief: string,          // a short headline answer to the topic
  paperCount: number,
  scanComposed: 1
}`;
