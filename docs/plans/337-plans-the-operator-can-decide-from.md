# Plan 337 — Plans the operator can decide from

**Status:** P0 merged. P1, the card on the node record and the writers' guidance, is built. P4, the operator's note on a node, is built. P3's template is built, and its `card` in the commission result is not. P2 is not built (§6).

**Builds on:** Plan 322 (plan nodes, `decide` nodes and D9's answer as the outcome), Plan 329 (the planning skill and D1's proposal), Plan 331 (the resident and P2's proposals), Plan 332 (the rail, **Approve** and **Reopen**), Plan 333 (the writing rules and D3: nothing checks them).

**Leaves alone:** the node's `goal` as the commission brief, the stream's decisions in `plan.node.next`, the Action Center's `plan-decision` item, every existing node and plan document.

## Decision card

**What changes**

- Today: a node shows its goal, criteria and note as blocks of prose. The operator reads all of it to find the decision.
- After: a node that asks for a decision carries a card with fixed sections. The rail shows each section as a heading and a list.

**Why**

- The operator has said that plans are hard to read and lack the structure a decision needs.
- The rail renders the goal, the criteria and the note each as one prose block (`PlanRail.tsx`).
- No field on the node holds a risk, an open question or a recommended answer (`plan.ts`).

**What it affects**

- `@aflow/schemas`: the card on the node record and on its create and update inputs.
- `@aflow/database`: one nullable `card` column on `plan_nodes`, added by tenant migration.
- `@aflow/cybernetic-runtime`: the plan store reads and writes the column.
- `@aflow/web-product`: the rail renders the card and offers **Read the plan**.
- The Helmsman's prompt, the `plan.node.*` usage text and the plan-document template in `docs/plans/README.md`.

**Risks**

- Writers may fill each item with long prose. The card then reads as badly as the goal does today.
- The card on the node may drift from a plan document that changes after it. Mitigation: the node links the document at the sha the card matches.
- A tight ceiling refuses a useful card and makes the writer retry. Mitigation: the ceilings are storage ceilings, set generously.
- The card adds tokens to every `plan.node.get` the Helmsman reads. Mitigation: P1 measures the cost of a full card.

**Open questions**

- Does a node that asks for no decision carry a card? Recommended: the field is optional on every node. The guidance asks for it only on nodes that ask for a decision.
- Does **Approve** with no answer accept every recommended answer? Recommended: yes. The note records each recommended answer under `Approved: …`.
- Does the commission result carry the card as data? Recommended: yes, as an optional field, added in P3.
- How does a node link a plan document in a folder with no remote? Recommended: the link's ref is the path and the sha, shown as text.

**Not done on purpose**

- No validator reads the card's style. Plan 333 D3 holds.
- No existing node or plan document is migrated.
- No plan body is stored in memory.
- No whole plan document is stored on the node.

**Done when**

- The operator approves or amends §3 from this card and the decisions under it.

## 1. Problem

The operator decides from the board. A node there reads as prose: a goal, criteria and a working note (`packages/web-product/src/ui/components/plan/PlanRail.tsx`). The prose is useful, but it has no fixed place for what changes, why, the risks or the open questions. The operator must read all of it to find the decision. The full record lives in a plan document in the repository, and the rail does not link it.

The operator asked for a template that makes a plan readable. It highlights the changes, the reasons, the risks and the open questions. The operator also asked whether the node or memory should hold the whole record. They asked for ASD-STE100 in spirit.

This round changes documentation only. The facts below come from reading the code at `70967257`.

## 2. What the code shows today

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **The node holds prose fields only.** `PlanNodeSchema` in `packages/schemas/src/cybernetic/plan.ts` carries `title`, `goal`, `criteria`, `note` and `outcome`. Each prose field has a storage ceiling of `PLAN_NODE_PROSE_MAX_CHARS`, 64,000 characters. `plan_nodes` stores each as a `TEXT` column (`packages/database/src/tenant/migrations/migration218.ts`).                       |
| F2  | **The goal is the commission brief.** The `plan.node.create` pitfall says "a round's brief is the node's goal and criteria" (`packages/schemas/src/operations/plan/registrations.ts`). The `plan.node.update` pitfall says every session is briefed from the goal.                                                                                                                      |
| F3  | **The rail renders prose.** `PlanRail.tsx` shows **Now** (the note's first line), **Goal**, **Done when** (or **Decided when** on a `decide` node), **Working note** folded, **Outcome**, **Runs** and **Carried forward**. Each text section is one `Text` block.                                                                                                                      |
| F4  | **The rail does not show document links.** `PlanNodeLinkKindSchema` has a `document` kind. Its ref is "a memory path or URL", and nothing validates it. The rail reads `run` and `finding` links only.                                                                                                                                                                                  |
| F5  | **Two answer paths exist.** A `decide` node closes through **Decide**, and the answer becomes its `outcome` (`PlanNodeCloseControl.tsx`, Plan 322 D9). A `blocked` node opens through **Approve**. Its optional `why` lands above the note as `Approved: …` (`PlanNodeOpenSchema` in `plan.ts`, `packages/cybernetic-runtime/src/plan/operations.ts`).                                  |
| F6  | **A stop writes a note only.** `stop` in `packages/cybernetic-runtime/src/plan/stream.ts` sets the node `blocked` and puts `Blocked: <why>` above its note. The engine writes no other prose.                                                                                                                                                                                           |
| F7  | **`PlanProposalSchema` does not exist in code.** A search of `packages/` finds it only in Plan 329's text. Plan 329 D1 describes it: phases, steps, risks with mitigations, open questions and evidence refs.                                                                                                                                                                           |
| F8  | **Plan 329 states a wrong ceiling.** Plan 329 D1 says the node fields hold 8,000 characters. The code holds 64,000 (F1).                                                                                                                                                                                                                                                                |
| F9  | **The resident proposes nothing on main.** `packages/cybernetic-runtime/src/plan/resident.ts` wakes the Helmsman. No code on main creates a proposal or a findings carrier. Plan 331 P2 designs both, on branch `aflow/plan-331-p2-ask-and-propose`.                                                                                                                                    |
| F10 | **A commission reads the folder, not the plan.** Commission Change (`packages/platform-artifacts/src/skillCatalog/commissionChange.ts`) takes the brief as `task`, capped at `COMMISSION_BRIEF_MAX_LENGTH`, about 32,000 characters. The coding agent works in a checkout at `base`. It reads a plan document there because the brief names its path. No input carries a plan document. |
| F11 | **The commission result carries a summary only.** `COMMISSION_RESULT_SCHEMA` in `commissionChange.ts` asks for `summary`, a title and one paragraph. `resultInstruction` in `apps/aflow-executor-host/src/handlers/harnessHandlers.ts` adds `WRITING_STYLE_RULES`.                                                                                                                      |
| F12 | **The writing rules are guidance.** `WRITING_STYLE_RULES` in `packages/schemas/src/runtime/writingStyle.ts` is placed in the Helmsman's prompt, the harness result instruction, Compose-skill and `CLAUDE.md`. Plan 333 D3 rules that nothing checks it.                                                                                                                                |
| F13 | **The plan-document template has no card.** `docs/plans/README.md` asks for the problem, decisions with rejected alternatives, what it affects, phases and proof. It prescribes no first section.                                                                                                                                                                                       |

## 3. Decisions

### D1 — The card is structured data on the node, with fixed sections in a fixed order

A node gains an optional `card`. Its shape is a rule, so it lives in the schema. What each section means is ontology, so it lives in the field descriptions and the usage text. The sections, in order:

| Section             | Field       | Shape                                 |
| ------------------- | ----------- | ------------------------------------- |
| What changes        | `change`    | `{ today, after }`, one item each     |
| Why                 | `why`       | a list of items, at least one         |
| What it affects     | `affects`   | a list of items                       |
| Risks               | `risks`     | a list of `{ risk, mitigation? }`     |
| Open questions      | `questions` | a list of `{ question, recommended }` |
| Not done on purpose | `notDoing`  | a list of items                       |
| Done when           | —           | the node's `criteria`, rendered last  |

**Every stored section is required.** The schema requires all six: `change`, `why`, `affects`, `risks`, `questions` and `notDoing`. `change` holds both items, and `why` holds at least one. The other four lists may be empty. An empty list says the writer found none. A card that omits a section is refused.

**Done when is derived, not stored.** The node already holds `criteria` (F1). A second copy in the card would drift from it. The rail renders `criteria` as the card's last section.

**Every question carries its recommended answer.** The schema requires `recommended`. A question without one asks the operator to do the planning.

**A risk carries its mitigation where there is one.** Plan 329 D1 gives each risk a mitigation. The same pair here lets a proposal become a card with no translation.

**The ceilings are storage ceilings.** An item is a trimmed string of at most `PLAN_NODE_CARD_ITEM_MAX_CHARS`, 4,000 characters. A list holds at most 50 items. The whole card, serialised, holds at most `PLAN_NODE_PROSE_MAX_CHARS`, the ceiling every other prose field has. Nothing breaks below these numbers. P1 measures the tokens a full card adds to `plan.node.get` and records the number here.

**Measured (P1).** The platform's estimate is 3.5 characters a token (`estimateStringTokens`). This document's own card, every section filled, serialises to 2,396 characters, so it adds 685 tokens to `plan.node.get`. A card at the whole-card ceiling adds at most 18,286 tokens. Every result that returns the whole node carries it: `plan.node.get`, the node a create, update or depend returns, and the rail's detail read. A list, a tree, the attention block and a brief do not. The declaration of the tool is a separate cost, paid every turn. The card's shape and description add 207 tokens to `plan.node.create` and 106 to `plan.node.update` (`estimateToolSchemaTokens`, measured in P3).

**Style is guidance only.** The guidance asks for one or two short sentences per item. It asks for one topic per sentence, active voice, one word per concept and under about 25 words. No validator reads it (D4).

**It is stored as one `jsonb` column.** Plan 322 D1 chose columns over a JSON bag because readers query status and parent. Nothing queries a risk. The rail and `plan.node.get` read the card whole, and Zod validates it at write.

_Rejected:_ a convention inside `goal`. The goal is the commission brief (F2). Headings in it would reach every coding agent as noise. Nothing could tell a section from a paragraph, so the rail could only render prose again. A missing recommended answer would be invisible.

_Rejected:_ a column per section. Six columns would always be read together, and a migration would follow every new section.

_Rejected:_ a `doneWhen` field on the card. It mirrors `criteria`, against the house rule to derive and never mirror.

_Rejected:_ tight caps, such as 200 characters an item. A model writes the useful sentence, validation refuses it, and the writer retries (`CLAUDE.md`, "A length cap is a storage ceiling").

### D2 — The plan document stays in the repository, and the node links it at a sha

**Where the full record lives.** The plan document stays under `docs/plans/`. It is versioned with the code it describes. The loop reviews it as a pull request. It ships with the product. The coding agent reads it in its checkout when the brief names it (F10).

**The card is written once, as data.** The sketch said the card is the document's first section, written once. No code writes a node and a document in one act. A harness may not write the plan (Plan 322 D3), and the Helmsman changes the repository only through a commission. The code supports this path instead:

1. The harness writes the card once, as data, in its result. P3 adds an optional `card` to `COMMISSION_RESULT_SCHEMA` (F11).
2. The harness renders the same data as the document's first section, by the template (D4).
3. The Helmsman writes that data on the node unchanged.

Both copies come from one write. The node's `document` link names the sha they match.

**The link.** When the document's pull request merges, the Helmsman links the document to the node as a `document` link. Its ref is the file's URL at the merge sha. Before the merge, the node holds the `pull_request` link it holds today. A folder with no remote gets the path and the sha as the ref. The rail shows that ref as text.

**Read the plan.** The rail reads the newest `document` link and offers **Read the plan** (P2). The rail does not show document links today (F4).

_Rejected:_ memory as the store for plan bodies. Memory is not versioned with the code. The loop does not review it. It does not ship with the product. The coding agent does not read it, because a commission reads the folder (F10). It splits the record across two stores. Plan 322 D1 rejected a memory-store document for the plan itself.

_Rejected:_ the whole document on the node. The board is for deciding, not reading. The coding agent reads the folder, so a copy on the node has no reader who needs it. Plan 336 is about 40,000 characters, most of the node's prose ceiling.

_Rejected:_ a parser that reads the card back from the document. A formatting slip would become a refused write. That is a style validator by another name.

_Rejected:_ the rail fetching the document's first section live. The board would then depend on the remote at every read, and a local folder may have none.

### D3 — The rail renders the card as sections, and answers use the paths that exist

**Rendering.** When a node has a card, the rail shows it above **Goal**, in D1's order. **What changes** shows _Today_ and _After_ on two lines. **Why**, **What it affects**, **Risks** and **Not done on purpose** are lists. Each risk shows its mitigation under it. **Open questions** is a list, and each question shows _Recommended:_ and its answer. **Done when** renders `criteria`. With a card present, **Goal** folds as **Working note** does. A node with no card renders as today.

**Answers use the decide path and the note.** Both exist (F5). This is the smaller choice.

- On a `decide` node, **Decide** prefills its outcome with each question and its recommended answer. The operator edits any line and records it. The outcome is the answer, as Plan 322 D9 rules.
- On a `blocked` node, **Approve** offers an optional answer per question. The rail fills each unanswered question with its recommended answer. It joins the answers into the one `why`, one line per question, so the note gains `Approved: …`.
- The rail shows the recorded answers where they land today: **Now** and **Working note** for a note, **Outcome** for an outcome.

**Approve stays one action.** Approve with no answer accepts every recommended answer. The rail still sends one open write. Its `why` lists each question with its recommended answer. The node's note then records the decision, and the Helmsman reads it there (D4).

_Rejected:_ an `answers` field on the card, written by new operator routes. It adds a write path, an authority rule and a second author to the card. The note and the outcome hold the answer already. P2 records whether the joined text reads well enough. A later plan may add the field if it does not.

_Rejected:_ a confirm step before Approve. It turns one action into two for the common case, in which the operator accepts the recommendations.

### D4 — Every writer of a plan produces the card, by guidance only

| Writer                                 | Where it reads the card and the writing rules                                                                                                                                                                                                                                                                                             | Note                                                                                                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Helmsman writing nodes             | The `card` field descriptions in the `plan.node.create` and `plan.node.update` declarations, and their usage text. Each description points at the writing rules in one sentence. The rules themselves are in the writing-rules section of `packages/cybernetic-runtime/src/helmsmanPrompt.ts`, which names node cards and plan documents. | A stop's card is the Helmsman's, on its next turn. The engine writes only `Blocked: …` (F6).                                                                                                                                        |
| The planning skill (Plan 329)          | The `PlanProposalSchema` declaration, when Plan 329 P1 builds it                                                                                                                                                                                                                                                                          | It does not exist yet (F7). Its risks and open questions reuse D1's item shapes, so a phase's card is the proposal's own. Plan 329 D1's 8,000 should read 64,000 (F8). P1 corrects it.                                              |
| The resident's proposals (Plan 331 P2) | The `plan.node.create` declaration, its `card` description included                                                                                                                                                                                                                                                                       | Not on main (F9). A findings carrier lists its findings under **Why**. The resident may not rewrite the card of a person-approved node or a blocked proposal. P2 sets that rule for `goal` and `criteria`, and the card follows it. |
| The harness writing a plan document    | The template in `docs/plans/README.md`: the card first, then the writing rules. From P3, also the `card` in the commission result                                                                                                                                                                                                         | The template opens with the card, and P3 has built it. The commission result's `card` is not built.                                                                                                                                 |

**Guidance only.** Plan 333 D3 holds. No validator, lint, guard or review blocks a write for style. The schema refuses a card only for its shape: a missing section, a question with no recommended answer, or a storage ceiling passed.

_Rejected:_ a style check on the card, such as a sentence-length limit. Plan 333 D3 refused that machinery, and a refused write makes the writer retry.

### D5 — Existing nodes and documents are not migrated

New nodes and new plan documents carry the card. Existing ones keep their prose, and the rail renders them as today. The operator asks a Helmsman to write a card for any open node they want to decide on. The Helmsman writes it with `plan.node.update`, against the node's revision.

_Rejected:_ a backfill run over open nodes. A model would write cards for decisions nobody asked about, and the operator would review them all.

_Rejected:_ rewriting Plans 315 to 336 with a card. They record decisions already taken.

## 4. What it affects

- `@aflow/schemas`: `PlanNodeCardSchema`, its ceilings, `card` on `PlanNodeSchema`, `PlanNodeCreateSchema` and `PlanNodeUpdateSchema`, and `card` in `PLAN_NODE_UPDATE_FIELDS`. From P3, an optional `card` in `COMMISSION_RESULT_SCHEMA`.
- `@aflow/database`: a tenant migration adding a nullable `card jsonb` to `plan_nodes`.
- `@aflow/cybernetic-runtime`: the plan store and `plan.node.get` carry the card.
- `@aflow/web-product`: the rail's card sections, **Read the plan**, the prefilled **Decide** and the per-question answers on **Approve**.
- `packages/cybernetic-runtime/src/helmsmanPrompt.ts` and `packages/schemas/src/operations/plan/registrations.ts`: the guidance.
- `docs/plans/README.md`: the template.
- `packages/platform-artifacts/src/helpCenter/articles/`: the plan page's article, for the new rail sections.
- Unchanged: `goal` as the brief, `plan.node.next`, the Action Center item, every existing node and document.

## 5. How it is proven

Each case fails if the change is wrong.

- **Shape.** `PlanNodeCreateSchema` accepts a card with every section and an item of 4,000 characters. It accepts an empty `risks` list. It refuses a card with no `risks` section, a question with no `recommended`, and a card whose serialised form passes 64,000 characters.
- **No style check.** A card item of one 60-word sentence with a semicolon is accepted.
- **Derived Done when.** The rail renders `criteria` as **Done when** under a card. A card holding a `doneWhen` field is refused as an unknown key.
- **Brief unchanged.** A commission briefed from a carded node carries the goal and criteria, and no card section.
- **Old nodes.** A node with no card renders **Goal**, **Done when** and **Working note** as today.
- **One action.** **Approve** with no answers sends one open write. Its `why` lists each question with its recommended answer.
- **Answers recorded.** **Approve** with an answer to the second question writes a note whose first line is `Approved:`. The note holds that answer and the recommended answer to every other question. **Decide** prefills each question with its recommended answer.
- **Read the plan.** A node with a `document` link shows **Read the plan**, which opens the newest link's ref.
- **Writer rule.** A resident write that changes the card of a blocked proposal is refused, once Plan 331 P2 lands.

## 6. Phases — proposed, built only after this document merges

**P0 — This document and its index row.** _Exit:_ the operator approves or amends §3.

**P1 — The card on the node record and the writers' guidance (D1, D4, D5).** It holds these parts:

- `PlanNodeCardSchema`, its ceilings, and `card` on the node, its create and its update.
- The tenant migration and the plan store.
- The field descriptions, the usage text and the Helmsman's prompt.
- The measured token cost of a full card in `plan.node.get`, recorded in D1.
- Plan 329 D1's stated ceiling, corrected from 8,000 to 64,000 characters (F8).

P1 corrects Plan 329 because P0's range holds only this document and its index row.

_Exit:_ the shape cases in §5 pass. A Helmsman asked to propose a phase writes a node with a card on the live stack.

P1 is built. It holds these parts beyond the list above:

- **The link at the merge sha (D2).** No phase built this guidance, and P2's **Read the plan** renders from it. A `plan.node.link` pitfall and the `document` ref description tell the Helmsman to link a merged plan document at its merge sha. A folder with no remote gets the path and the sha.
- **The resident's proposals (D4).** The board's `propose` answer asks for a card on the proposal. The `revise` guidance rewrites the card with the goal and criteria.
- **The harness writing a plan document (D4).** Until P3's template, the harness is told through the brief. A `plan.node.create` pitfall and the card's description in its declaration say a commissioned plan document opens with the same card.
- **Migration 234** adds the nullable `card jsonb` column. Plan 331 P2 withdrew 232, and its guard refuses that number. Plan 336 P1 holds 233, merged to main. Tests: `planCard.test.ts` in `@aflow/schemas` and in `@aflow/cybernetic-runtime`, a case in `planStore.pg.test.ts`, and `migration234.test.ts`.

Where the code differed from the design's reading:

- A whole card in the declaration costs about 340 tokens an operation, and the Helmsman pins both writes. So the declaration carries the card as a described object, and its description holds a one-line shape. The shape is derived from `PlanNodeCardSchema`, so it cannot drift from the schema. Dispatch validates against the full schema. The two writes add 313 tokens to every Helmsman turn (D1). The prompt's 74 tokens of card guidance have moved out of the prompt. A pitfall never reaches a pinned tool's declaration, so the `card` description on `plan.node.create` carries the rules every turn. It says to answer every question with a recommendation, to open a commissioned plan document with the same card and to link that document at the merge sha. The context-budget baseline has moved back down for the prompt.
- A `jsonb` column returns keys in its own order. `readStoredPlanNodeCard` reads the card back in D1's order, and an update compares cards by their serialised form. The same card sent again is refused as a write that changes nothing.
- A card written before a schema change may fail the schema now. A node read then carries no card, and the store warns of the refusal with the node's id. It warns once for each node and card hash, and logs each later read of that card at debug. The node still passes its output schema, and the next card written replaces the stored one.
- A resident rule exists on main for the goal and criteria, before Plan 331 P2. A resident may rewrite them only to answer a Revise. The card follows that rule now (D4).
- `plan.node.update` replaces a card whole and never removes one. The design names no removal. The executor checks arguments against the declared object, so a `null` card would be refused before dispatch.
- The engine's findings carrier gains no card. The engine writes no prose beyond its own lines (F6), and D4 leaves the carrier's card to Plan 331 P2.
- Plan 329 has no `PlanProposalSchema` yet (F7). Its D1 now says the proposal reuses the card's risk and question shapes.

**P2 — The rail renders the card (D2's link, D3).** It holds the card sections, **Read the plan**, the prefilled **Decide**, the per-question answers on **Approve** and the help article. _Exit:_ the rail, answer and link cases in §5 pass. The operator decides one carded node from the rail without opening its document.

**P3 — The plan-document template and the README (D2, D4).** It holds the card as the first section of the template in `docs/plans/README.md`, and the optional `card` in the commission result. _Exit:_ a commissioned plan document opens with the card, and its commission result carries the same card as data.

The template is built. It opens with the card, then a literal copy of `WRITING_STYLE_RULES`. The `card` descriptions on `plan.node.create` and `plan.node.update` each point at those rules in one sentence. The Helmsman prompt's writing rules now name plan documents. The `card` in the commission result is not built.

**P4 — The operator answers a node with a note (built).** The operator asked to approve with instructions, to send a proposal back with a note, and to discuss a node. P4 builds all three and adds no table and no comment thread.

- **Approve with instructions.** On a blocked step the rail shows **Instructions for the work** before the click, with the placeholder "Do it, and make sure…". The engine writes the words as one `Approved: …` line above the note (`planNodeOperatorLine`). Line breaks fold to spaces, so the attention block, **Now** and the brief each read all of it. The brief node of every `plan.node.next` decision carries that line as `instructions` (`planNodeInstructions`), and the `continue` guidance opens the commission brief with it.
- **Revise.** `PATCH /v1/spaces/:spaceId/plan/nodes/:nodeId/revise` takes `PlanNodeReviseSchema` `{ expectedRevision, why }`. `revisePlanNode` refuses a node that is not blocked. It writes `Revise: …` above the note and leaves the status blocked. The write moves the revision and wakes the resident. `plan.node.next` answers a blocked node whose note opens with `Revise: ` with the `revise` decision. It looks for one on any node under the stream's root, not only the active node, because the walk to the active node stops at the first blocked one. The active node's decision comes first where it records a merge or publishes, as the board ranks them. The revise write keeps the revision it wrote in Redis (`planNodeReviseKey`). A later write that leaves the `Revise: ` line in place is a rewrite the line survived: the stream stops asking and answers `wait` with cause `revise_unanswered` where nothing else is to do. A revise is answered once per revision, as an ask is. The firing that gives it records the revision under `planNodeReviseAnsweredKey`, by a compare-and-set that one of two racing wakes wins. A wake that answers and writes nothing leaves the node at that revision, so later wakes answer `revise_unanswered` and the root's other work goes ahead. A new Revise moves the revision and is answered again. A proposal the operator sent back and then dropped counts as declined: the board reads its whole note for the `Proposed: ` line below the operator's line. The Helmsman rewrites goal and criteria with `plan.node.update` and replaces the line with one that begins `Revised: `. No agent gains a write: the Helmsman already updates blocked nodes. Audit action `plan.node.revise`.
- **Discuss.** **Discuss with the Helmsman** opens the space chat with `?draft=` holding the step's title and id. A `plan.node.update` from a session started by `chat` or `voice` links that session to the node as a `session` link labelled `conversation`. A link leaves the revision where it stands, so the writer's next update is not refused as stale. The rail lists those conversations under **Discuss**. Its read names `linkLabel=conversation`, so the label is filtered before the page is cut.

Where the code differed from the design's reading:

- The asked-once rule is not on main. It lives in the plan engine's `asks.ts` on branch `aflow/plan-331-p2-ask-and-propose`, keyed on the revision a node was asked at (`isAsked`). The revision moves in `updateAtRevision` in `packages/cybernetic-runtime/src/plan/store.ts`. A revise is an update, so it re-arms that rule once the branch lands.
- No rule on main lets a person's write supersede an agent's. `PlanWriteContext.actorKind` is set by the route and the inline ops and read by nothing. What holds is the revision compare-and-set: the first write wins and the other is refused as stale. A round started before a node's last write does not count against it (`latestRoundSinceWrite`).
- The brief node carried the note, but the guidance briefed a commission from the goal and criteria only. So an `Approved: …` line reached the wake but not the commission. P4 adds `instructions` and the guidance to open the brief with it.
- The overview's lane row keeps its one-click **Approve** with no words, as D3 keeps Approve one action.
- `readPlanLoopMeasure` counts `plan.node.close` and `plan.node.open` only. P4 leaves it alone, so a revise is not yet counted as an operator action.

_Exit:_ the regression tests in `planOpenPlace.test.ts`, `planStream.test.ts`, `planNodeOps.test.ts`, `plan.test.ts` and `space-plan.test.ts` pass.
