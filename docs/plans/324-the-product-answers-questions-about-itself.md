# Plan 324 — The product answers questions about itself

**Status:** 🔨 P0 built: the article schema, the catalog and its search, the anchor and vocabulary tests, and a first 31 articles across every theme from discovery pass 1. P1 built and tested without a live stack; its exit is proven on the live stack after merge. P2–P4 not started.

**Builds on:** the platform-artifact registry (Plan 106) as the home for content that is identical for every tenant, the Store catalog (`packages/platform-artifacts/src/storeCatalog/`) as the template for a code-owned catalog with a search, a server route and an inline op over one source, the route manifest (`packages/web-product/src/ui/routeManifest.ts`) as the authority on which screens exist in which edition, and the space LLM readiness read (`GET /spaces/:spaceId/llm-readiness`) as the signal that tells the UI whether an agent can answer at all.

## 1. Problem

The product has no help. There is no FAQ, no glossary, no getting-started page and no "learn more" link anywhere in the web UI. What explains the platform today is scattered: `README.md` and `docs/dev/local-appliance.md` for installing and running it, about sixty empty-state strings, the remediation text in server refusals ("Add one under Settings → Credentials"), the onboarding wizard, and the op registry's `semanticDescription` / `usage` — which the agent reads and the operator never sees. None of it is reachable from a question.

The Helmsman cannot answer questions about the platform either. It knows its tools, not the product: asked "why is this write waiting for me?" or "what is the Coach?", it has nothing authoritative to read and answers from the model's guess. And an operator who has not yet added a model provider — the moment questions are most likely — has no agent to ask.

A help center has to stay true as the platform changes. Content written once and left behind is worse than none, because the reader trusts it.

## 2. Decisions

**D1 — Help content is a code-owned catalog in `platform-artifacts`, not a seeded space.** Each article is a typed record (`HelpArticleSchema`, `packages/schemas/src/help/`) in `packages/platform-artifacts/src/helpCenter/`, one module per theme, reviewed in the pull request that changes the behaviour it describes. _Rejected:_ a default "Help" space whose FAQ lives as memory documents and whose Helmsman answers from them. The platform owns no read-only memory — every path but `/run/` is writable, so tenant copies drift from the product and from each other. Putting a space in every tenant is a tenant migration or a deploy-time sweep, which Plan 106 retired for platform content, and every later edit is another sweep. Semantic memory search needs an embedding key in the process environment and silently degrades to full text without one. And the question arises in the space the operator is working in, whose Helmsman can see that space's readiness, bindings and paused runs; a Helmsman in a separate help space can see none of it.

**D2 — One source, three readers.** The same articles are served to a browsable page, to the Helmsman through an operation, and to contextual links from the screens that need explaining. No reader holds a copy.

**D3 — The browsable page needs no language model.** `/help` is a route in both editions, rendered with the existing `MarkdownRenderer` from a core server surface `help` (`GET /v1/help/articles`, `GET /v1/help/articles/:articleId`), searched with the field-weighted BM25 the Store already uses. An operator with no provider configured reads the same answers the agent does. _Rejected:_ shipping the articles in the web bundle — `web-product` does not depend on `platform-artifacts`, the server already filters by edition, and a second path to the content is a second thing to keep in step.

**D4 — Articles are filtered by edition at the server.** Each article names the editions it is true in (`EditionIdSchema`: `enterprise`, `community-local`). The route and the operation return only the articles true in the process's edition, so a local operator never reads about inviting members and a hosted one never reads about pairing this computer. _Rejected:_ filtering in the UI — the operation has no UI, and two filters drift.

**D5 — The Helmsman reads help to answer the operator's questions about the product, and for nothing else.** Its instructions and op descriptions tell it how to act; nothing tells it what the operator sees — screen names, navigation paths, what a setting means, what one edition lacks. That is what an article holds, and what the Helmsman guesses today. `catalog.help.search` and `catalog.help.get` are inline, read-only ops under `catalog`, the step type for finding what the platform offers; the capability group `catalog.help` is added to the system profiles, read only, in one tenant migration. They are **promotable, not pinned**: `whenToUse` is the operator asking how the product works or where something is, and `whenNotToUse` is deciding how to act — the op registry is the authority on behaviour, and an article describing the Helmsman ("the Helmsman asks before…") describes it to the operator and never instructs it. The search output carries each article's `summary`, so one call answers most questions. _Rejected:_ pinning the ops in `coreOperations` before measuring — every turn pays for a tool most turns do not need, and an always-visible knowledge base invites reaching for it on questions the tools already answer; a read-only virtual memory mount (`/platform/help/`, beside `/run/`) the Helmsman reaches through `memory.store.*` — no new op, but search and links read stored documents, so both would be rebuilt over the registry inside the memory handlers, and memory stops meaning the space's own knowledge; articles seeded as memory documents so general memory search finds them — a search about the operator's notes returns platform FAQ, and the seeding problems of D1 return; a separate Helmsman-facing knowledge base — a second body of content to keep true, in a format (question, summary, navigation path) the Helmsman's own reasoning does not need; a `help` step type — an ontology entry for two read operations that belong with discovery; prompt prose about the product — prompts are the last resort.

**D6 — An article names what it describes, and a contract test holds the names.** `anchors` lists the route ids (`ROUTE_MANIFEST[].route`) and operation ids an article explains. A route anchor must exist in every edition the article claims. A test fails when an anchor no longer exists, so removing or renaming a feature fails CI until its articles move with it. The test enforces one property — every anchor resolves — and is probed with a deliberate violation. _Rejected:_ a content hash of the anchored source files, refreshed by hand — it fails on every refactor that changes nothing an operator sees, and is soon refreshed without reading.

**D7 — Coverage is a test once the content exists.** When the discovery pass (§5) is complete, a second test requires every user-facing route in the manifest to be anchored by at least one article true in that route's editions, so a new screen cannot ship without an answer. It lands in P4, not P0: a coverage rule over a half-written catalog is an exception list, and an exception list is where coverage goes to die.

**D8 — Help speaks the product's vocabulary.** Article text is held to `copyVocabulary.test.ts`: "coding agent", not "harness"; "Store", not "Shop"; "Helmsman", not "cybernetic agent".

**D9 — Skills are a theme of their own.** A skill is the unit an operator installs, runs, schedules, evaluates and improves; questions about it span concepts, the Store, triggers, evals and Coach proposals. Folding it into "concepts" or "automation" splits the most-asked subject across two shelves.

## 3. Design

### 3.1 The article

```ts
HelpArticleSchema = z.object({
  id, // kebab-case slug, stable — links and the Helmsman cite it
  theme, // HelpThemeSchema
  question, // as an operator would ask it
  summary, // the answer in one paragraph, plain text: the list row and the agent's first read
  body, // the full answer, markdown
  editions, // non-empty EditionId[]
  anchors: { routes, operations },
  related, // other article ids
  keywords, // search terms the question and summary do not contain
});
```

Themes: `getting-started`, `models`, `privacy`, `concepts`, `skills`, `approvals`, `integrations`, `this-computer`, `automation`, `teams`, `troubleshooting`. Article ids are unique; `related` ids resolve; a theme is a closed enum so the page's index is fixed.

A route anchor is a manifest route (`s/[space]/settings/write-policy`). A body names where things are as the screens label them (**Settings → Write Policy**) rather than linking to a route, so it reads the same in any space; the links on an article page are its related articles.

### 3.2 Readers

| Reader              | Phase | Reads                                                                |
| ------------------- | ----- | -------------------------------------------------------------------- |
| contract tests      | P0    | every article: schema, unique ids, related ids, anchors, vocabulary  |
| `/v1/help/articles` | P1    | summaries for the edition, optionally searched (`?q=`) or by `theme` |
| `/help` page        | P1    | the route above; an article in full from `/v1/help/articles/:id`     |
| `catalog.help.*`    | P2    | the same two reads, for the Helmsman answering an operator           |
| contextual links    | P3    | an article id from an empty state, banner or refusal                 |

The page is tenant-level and reads as an index, the way the Memory Explorer does: themes down the side with their questions under the open one, and the open theme's every question with its short answer beside it, each opening its full answer in place. Search replaces the index with matching questions. The selection lives in the URL (`/help?theme=…&article=…`); `/help/[articleId]` opens the index on that article, so a screen can link one answer. It is reached from **Help** in the sidebar footer in both editions, and reads under the query key `['help', …]` — help is the same in every space, so it does not nest under `['space', spaceId]`. From P2 it offers "Ask the Helmsman", passing the article being read; until the Helmsman can read articles, that button would hand it a question it can only guess at.

## 4. What it affects

- `packages/schemas` — `help/` (article and theme schemas); P2: `operations/` registrations for `catalog.help.search` / `catalog.help.get`, the registry.
- `packages/platform-artifacts` — `helpCenter/` (articles by theme, the catalog, search, the schema and operation-anchor tests), exported from the index.
- `packages/design-system` — P1: a `question` icon.
- `packages/web-product` — P0: the route-anchor and vocabulary tests (dev dependency on `@aflow/platform-artifacts`); the banned-word list moves out of `copyVocabulary.test.ts` into a module both tests read; P1: the `help` route in the manifest, the screen, the nav entry, `useApiQuery` reads under a tenant key `['help', ...]`.
- `packages/server-runtime` — P1: `routes/help.ts`, the `help` core surface in `compose/coreSurfaces.ts`.
- `apps/aflow-orchestrator` — P2: inline handlers, `dispatchInlineOp.ts`, the inline-op prefix.
- `packages/database` — P2: a tenant migration adding `catalog.help` read to the system profiles.
- `packages/platform-artifacts/src/cyberneticAgents.ts` — P2: the two ops in `HELMSMAN_DISCOVERY_PRESET`.

Nothing stored changes shape. No tenant data is written.

## 5. Building the content

The catalog is only as good as its discovery. Each pass produces questions; each question gets an answer written from the source and checked against the running product before it lands.

1. **Mine what already explains the product.** `README.md`; `docs/dev/local-appliance.md` (install, upgrade, backups, sandbox, coding agents, what the local edition lacks, exposure); `docs/dev/integrations-and-capabilities.md`; empty states in `packages/web-product/src/ui`; remediation text in `packages/server-runtime/src/routes`; the onboarding flow and setup checklist; op `usage` metadata for "what can an agent do with X".
2. **Walk the product cold, once per edition.** A fresh first run with no provider, through the browser, logging every point of hesitation as a question. This finds what no document mentions.
3. **Mine real conversations.** "How do I / why is / what is" questions asked of the Helmsman in existing sessions, and the known-gap lists in `docs/dev/`.
4. **Check every answer against the product.** The click path exists, the names match the screens, the edition is right.
5. **Close coverage.** Every route in the manifest, every core concept, and every refusal that names a remedy maps to an article (D7).

## 6. Phases

**P0 — The catalog and its contract.** The article schema, the catalog, the anchor and vocabulary tests, and a first batch of articles drawn from pass 1 across every theme. _Exit:_ removing a route or an operation that an article anchors fails the tests, naming the article; the first batch passes them.

**P1 — The browsable page.** The `help` surface, `/help` and `/help/[articleId]` in both editions, a theme index with search, every question in a theme on one page, related articles, and a **Help** entry in the sidebar. _Exit:_ on a fresh local stack with no provider configured, an operator finds and reads the answer to "how do I add a model provider"; the hosted-only articles are absent from the local list and the response.

**P2 — The Helmsman reads it, measured.** `catalog.help.search` / `catalog.help.get`, the capability migration, the ops in the Helmsman's promotable set, and "Ask the Helmsman" on an article — offered only when the current space's readiness reports a configured provider, and passing the article being read so that path does not depend on discovery. _Exit:_ on a fixed set of operator questions about the product (where a setting is, why a write waits, what the local edition lacks), the Helmsman finds and cites the article, and on questions about acting it does not call the op; if it fails to find the op while promotable, the ops are pinned and the set is run again.

**P3 — The screens point at it.** Empty states, the LLM readiness banner and remediation refusals carry article ids, rendered as links. _Exit:_ every remediation message that names a settings page links the article explaining it.

**P4 — The content is complete.** Passes 2–5, and the coverage test (D7). _Exit:_ the coverage test passes with no exception list.

## 7. How it is proven

- An article anchoring `s/[space]/settings/write-policy` fails the anchor test the moment that route leaves the manifest; the test is probed with a fabricated anchor.
- An article marked `community-local` only is absent from `GET /v1/help/articles` and from `catalog.help.search` in an `enterprise` process, and the reverse.
- The `/help` page renders and searches on a stack whose space reports `hasConfiguredProvider: false`.
- The Helmsman's answer to an approval question cites the article id it read, and a question about acting ("start the weekly report") reaches no `catalog.help.*` call.
