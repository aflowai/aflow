# Plan 333 — Agent-facing English is controlled

**Status:** 🌱 design. Nothing built.

**Builds on:**

- Plan 324: the emitted tool description is `semanticDescription` plus the operation's first `whenToUse`.
- Plan 322: plan nodes and the runs linked to them.
- Plan 315 D22: the fix round a publication hands on.
- Plan 331 D7: the loop's measure, `GET /v1/spaces/:spaceId/plan/loop`.

**Source:** the structural rules and the linter of [`danyuchn/asd-ste100-skill`](https://github.com/danyuchn/asd-ste100-skill) (MIT, v0.4.0, commit `8da6b63`). That skill borrows the rule categories of ASD-STE100 Issue 9.

## 1. Problem

Every agent in Aflow acts on English it cannot ask about. The Helmsman chooses a tool from its `semanticDescription` and `usage`. It reads a result through the descriptions of its output fields, and it recovers from an error by its message. The coding agent carries out a brief the Helmsman wrote. Nothing in the repository says what shape that English takes, and nothing checks it.

- **A misread brief costs a round.** A commission runs thirty to forty minutes (`COMMISSION_TIMEOUT_DEFAULT_MS`, `commissionChange.ts`). The coding agent can take a reading the brief's words allow and the node did not mean. Review then finds it, the publication decides `fix_before_merge`, and a fix round runs: a second commission, a second review. Nothing reads the brief before the coding agent does.
- **Nothing records why a round happened.** The board counts a node's rounds (`PlanTreeNode.rounds`), and the loop's measure counts operator actions and cost. No record says what caused a fix round. So the cost of brief wording is unknown today, and a claim that this plan reduces it could not be checked.
- **The catalog prose is long and joined by semicolons.** The table below is `ste-lint.py` run over this repository at `1b0835a8`. It read one file per operation and per catalog skill, so a synonym check covers one unit. Of the 206 operations offered to agents as tools, 53 have a semicolon in `semanticDescription`. The longest sentence in one is 64 words (`workflow.run.list`). A pinned tool carries that description in every turn (Plan 324), so a sentence the model must parse twice costs context in every turn.
- **One unit names one action with several words.** The linter flags 26 synonym rotations in the operations and 5 in the skills. `api.binding.test` says "check", "validate" and "verify". `api.http.call` says "get" and "fetch". The reader cannot tell whether the text describes one action or several. Some flags are two distinct actions, and the sweep decides each one.
- **The rules exist only as taste.** `CLAUDE.md` teaches by example how to write for an agent. No check reads the shape of the text, so a pitfall with three semicolons merges as easily as one with none.

| Surface                                                                                                 | Units | Words  | Hard findings | Semicolon | Sentence over 25 words | Synonym rotation | Marketing adjective, phrasal verb, nominalization | Advisory: passive, compound tense |
| ------------------------------------------------------------------------------------------------------- | ----- | ------ | ------------- | --------- | ---------------------- | ---------------- | ------------------------------------------------- | --------------------------------- |
| Operations: `semanticDescription`, `usage.whenToUse`, `usage.pitfalls`                                  | 229   | 25,610 | 409           | 205       | 178                    | 26               | 0                                                 | 266, 23                           |
| Skill catalog: tagline, descriptions, `usage`, run-input descriptions, output guidance, activation hint | 20    | 13,016 | 324           | 129       | 190                    | 5                | 0                                                 | 137, 11                           |

Marketing adjectives, soft phrasal verbs and nominalizations measured zero on both surfaces. Catalog prose was expected to hold marketing adjectives, and it holds none. So the guard holds them at zero, and no sweep is planned for them. Field descriptions on operation inputs and outputs, and error messages, are not in these numbers. P1 measures them.

## 2. Decisions

**D1 — The result is STE-inspired, never STE-compliant.** Three things stop it from being compliant, and all three are deliberate.

1. The approved-word dictionary is absent. ASD-STE100 is free to obtain and not free to redistribute. Issue 9 grants reproduction only to listed categories of organisation, and Aflow is in none of them.
2. Present perfect stays where it carries meaning. "The commission has ended" says its result is available now. "The commission ended" says only that it ended at some time. Status text needs the first.
3. Hedges survive every rewrite, and the linter never flags them. The platform often reports what it does not know. A push may have landed, or a check may have run out of time. The secret scan's own pitfall says "A clean scan says no rule matched, not that the range holds no secret." The Helmsman's next decision turns on that doubt. A rewrite that turns "may have pushed" into "pushed" skips the look at the branch that was needed. A rewrite that turns it into "did not push" starts a second push. A linter that pressed hedges out would make every fix sweep a change of claims.

_Rejected:_ calling the result compliant. Compliance cannot be verified without the dictionary, and a reader would trust the word. _Rejected:_ obtaining the dictionary for the repository. A check that contributors cannot run, over a word list the repository cannot publish, is not a check.

**D2 — Structural rules are checked and enforced. Lexical rules are direction only.**

- **Enforced, counted as hard findings:**
  - a semicolon
  - a sentence over 25 words
  - a soft phrasal verb
  - a nominalized action, such as `perform an analysis of`
  - a marketing adjective
  - a list item that ends in "and" or "or"
  - synonym rotation within one unit, in Strict mode only (D3)
- **Advisory, reported and never counted:** passive voice and compound tenses. The actor of "the call is refused" is the platform, and naming it in every sentence adds words and no meaning. STE allows passive voice where the actor is irrelevant, and D1 keeps the present perfect.
- **Direction only, never checked:** approved words, one part of speech per word, noun clusters, and a glossary of domain terms. The linter has no noun-cluster rule. It would need part-of-speech tagging, and a pattern without it fires on every domain term — "plan node run link" is four nouns and one meaning.

_Rejected:_ a noun-cluster pattern. Its false positives would teach contributors to ignore the guard. _Rejected:_ counting passive voice. Most of it in this repository is correct by STE's own exception.

**D3 — Two modes, chosen by the reader of the text.** **Strict** governs text a machine parses to decide what to do:

- operation `semanticDescription` and `usage` (`whenToUse`, `whenNotToUse`, `pitfalls`)
- field descriptions on operation inputs and outputs, the tool-result envelope
- agent-facing error message templates in `packages/schemas`
- the skill catalog prose in `packages/platform-artifacts`
- the sentences the host executor adds to every brief, and the brief itself

**STE-flavored** governs text a person or a later session reads as prose: the Helmsman's reports, plan node notes, and plan documents. Flavored mode keeps every structural rule and drops the synonym check, because prose needs some range of words.

_Rejected:_ one mode everywhere. Strict mode on a plan document produces flat text and loses the house voice. Flavored mode on a pitfall keeps the "check" and "verify" pair that makes an agent ask whether they are two steps.

**D4 — Controlled English lands as data, schema or a guard, never as prompt prose.** This is `CLAUDE.md`'s rule "Prompts are a last resort, not a tool surface". No system prompt gains a paragraph that asks for plain English. Each surface gets a check where its text is data. The registry and the catalog get a guard test (D6). The brief gets a teaching field on the harness result (D7). Review gets findings (D9), and reports get a skill (D10).

_Rejected:_ a rule in the Helmsman's system prompt. It drifts across model versions and no test reads it. It would also not reach the catalog strings, which contributors write, not the Helmsman.

**D5 — The linter is a TypeScript port in `@aflow/lib`.** `packages/lib/src/controlledEnglish/` holds the rules of `ste-lint.py` v0.4.0 as regular expressions. It keeps the same rule ids and levels, and the same Markdown handling. Fenced code is skipped and inline code masked. Tables, lists and quotes are read cell by cell and item by item. It exports `lint(text, options)` with `mode`, `disable` and `baseline`. The Python self-test cases become its unit tests, and "may have failed" passing clean is one of them. The module header and `NOTICE` carry the MIT notice. `@aflow/schemas` and the host executor already depend on `@aflow/lib`. `@aflow/platform-artifacts` gains the dependency.

_Rejected:_ running `ste-lint.py`. Python is not a dependency of this repository or of the operator's machine, where the host executor runs. _Rejected:_ vendoring the Python file. Vitest cannot import it, so the guard would spawn a process per test. _Rejected:_ a general-purpose prose linter from npm. Its rules differ, and the hedge exemption is the property this plan needs most. The port keeps that property under test.

**D6 — Strict surfaces are a guard with a baseline per unit, then a sweep to zero.** Guard tests read the strings as the agent receives them, derived at run time, never listed by hand:

- `packages/schemas`: every registered operation from `getAllOperations()` — `semanticDescription`, `usage`, the descriptions walked from `inputZod` and `outputZod` — and the agent-facing error templates the package exports.
- `packages/platform-artifacts`: every `SKILL_CATALOG` entry — tagline, descriptions, `usage`, `next`, run-input and state-variable descriptions, output guidance, activation hint, and task goals.
- `apps/aflow-executor-host`: the sentences `composeHarnessTask`, `resultInstruction`, `retryInstruction` and `mergeConflictSentence` add to a brief, built from fixtures.

A unit is one operation, one catalog skill or one sentence builder. `scripts/controlled-english-baseline.json` records the hard count of each unit by rule, and its count of modal hedges (may, might, could). The guard fails when a unit's hard count rises or a new unit has any hard finding. Its message names the unit, the field, the rule and the words. `scripts/controlled-english/cli.ts` has `scan`, `check` and `update-baseline`, as `scripts/context-budget/cli.ts` does. The sweep then takes every hard count to zero, a package at a time.

A rewrite in the sweep keeps every fact, condition and hedge. The guard fails when a unit's hedge count falls below the baseline. The context-budget check holds the token counts of the Helmsman's tool components as they stand. A rewrite that grows them is the wrong rewrite.

_Rejected:_ the sweep first and the guard after. Text lands during a sweep, and nothing holds it. _Rejected:_ one count for the whole repository. A fix in one operation could then pay for a regression in another. _Rejected:_ an ESLint rule. ESLint reads string literals, not the composed text: descriptions built by concatenation and from constants (`String(HOST_HARNESS_MAX_TURNS_DEFAULT)`) reach the agent as one string that no literal holds.

**D7 — The brief gets a teaching result, never a refusal.** `host.harness.run` lints its `task` input in Strict mode, as the caller wrote it, before the coding agent starts. The sentences the host adds are D6's. The run goes on whatever the findings are. Its output gains `briefFindings`: for each finding the rule, the words, where in the brief they are, and the rule's remedy. The field's description says what the findings are for: the next brief. Commission Change promotes them to its state, so the Helmsman reads them with the patch and the summary.

The lint belongs in the harness handler (`handlers/harnessHandlers.ts`), which receives the brief. `commitCheck.ts` runs a folder's declared checks on a commit and never sees a brief. The D6 guard still reaches that check runner without a change to it. The guard is a Vitest test, and `scripts/verify-commit.mjs` runs it as this repository's declared check.

_Rejected:_ refusing a brief that fails the lint. A refused commission costs the round the lint exists to save, and a refusal on style is a refusal the model misreads. _Rejected:_ a separate operation the Helmsman calls before it commissions. It would need a pitfall that tells the Helmsman to call it, which is a prompt rule in another form. _Rejected:_ holding the start until the brief is clean. A 26-word sentence is not a misread, and the delay is certain. A commission started with `wait: 'none'` returns its findings when it ends. The Helmsman reads them when it writes its next brief, for a fix round or the next node, and that is where they teach.

**D8 — A fix round records its cause.** A review finding gains `kind`: `defect` (the default), `brief_reading` or `prose`. `brief_reading` means the change carries out a reading the brief's words permit and the node did not mean. It requires `briefQuote`, the brief's words that permit it. Review Local Changes takes an optional `brief` run input. A publication that names its commission passes the commission's `task` there. The loop's measure (`readPlanLoopMeasure`, `PlanLoopMeasureOutputSchema`) gains `fixRounds`: the fix rounds in the window that serve a node, by cause. A fix round counts as caused by the brief when the review it answers holds a `brief_reading` finding whose `briefQuote` appears word for word in that brief. The match is exact, so a reviewer's paraphrase does not count.

_Rejected:_ the Helmsman tagging the cause of its own fix round. The author of a brief would grade the brief. _Rejected:_ labelling rounds by hand. A count nobody can repeat cannot show a change.

**D9 — Local Code Review reads prose with the linter, not by eye.** A read-only operation `host.commit.prose`, beside `host.commit.scan` and `host.commit.check`, reads the lines a range adds to Markdown files. It lints them in Flavored mode, and in Strict mode for the files agents read as instructions: `CLAUDE.md`, `AGENTS.md` and `SKILL.md`. The review skill runs it beside its harness task. Its findings are `proseFindings` on the run: review findings with `kind: 'prose'` and severity `nit`. They are separate from `findings`, so neither the verdict nor the publication's decision on findings can turn on them. A fix round that opens for a defect can carry them in the same schema. In this repository, agent-facing strings inside source files are D6's guard, which a `deep` review already runs as the project's own tests.

_Rejected:_ the reviewing coding agent judging prose. Its judgement differs between runs and spends review turns. _Rejected:_ prose findings in `findings` as `minor`. A publication that decides `fix_before_merge` on prose spends a round on a semicolon.

**D10 — Helmsman reports and node notes pass through a skill.** A catalog skill `write-plainly` rewrites a text in Flavored mode. Its one AI task takes its instructions from the skill's own data, which D6 governs. Its output is the text and a `keptAsIs` line naming any longer phrase it kept for precision. An advisory validator runs the linter on the output and returns findings on the run, never a refusal: a gate on style makes a loop. Its `usage.whenToUse` names a report that leaves the conversation for the operator and a node note a later session reads.

_Rejected:_ linting the note on every `plan.node.update`. It puts style findings in the result of every plan write, which the Helmsman reads in every turn. That is the context cost this plan works against. _Rejected:_ a prompt rule (D4).

**D11 — New plan text is held to Flavored rules. The archive is not rewritten.** `scripts/controlled-english/cli.ts check` reads the lines a change adds under `docs/plans/`, against `origin/main`, in Flavored mode. Their hard findings per 1,000 added words must not exceed the rate in the baseline file. P1 measures that rate on plans 315 to 333, and it only falls. A change that adds fewer than 300 words is reported and not failed. `scripts/verify-commit.mjs` runs the check. Lines a change does not touch are never read. The house voice stays: the system is the subject, and a plan records decisions, not narrative.

_Rejected:_ rewriting the archive. Each rewrite risks a changed decision or a lost hedge, and no reader gains. _Rejected:_ zero on new text from the first day. Plan prose carries reasons, and a cap that every author fights produces split sentences that lose their "because".

## 3. What it affects

- `packages/lib` — the linter (D5).
- `packages/schemas`:
  - the guard over the operation registry (D6)
  - `briefFindings` on `HostHarnessRunOutputSchema` (D7)
  - `fixRounds` on `PlanLoopMeasureOutputSchema` (D8)
  - `host.commit.prose` and its schemas (D9)
- `packages/platform-artifacts`:
  - the `@aflow/lib` dependency and the guard over `SKILL_CATALOG` (D5, D6)
  - Commission Change promotes `briefFindings` (D7)
  - `REVIEW_FINDING_SCHEMA` gains `kind` and `briefQuote` (D8)
  - Review Local Changes gains the `brief` input and the prose task (D8, D9)
  - Publish Local Changes passes the brief to its review (D8)
  - the `write-plainly` skill (D10)
- `apps/aflow-executor-host`:
  - the brief lint in the harness handler (D7)
  - the `host.commit.prose` handler, built as `commitScan.ts` is (D9)
- `packages/cybernetic-runtime` — `readPlanLoopMeasure` counts fix rounds by cause (D8).
- `scripts/` — `controlled-english/cli.ts`, `controlled-english-baseline.json`, and a step in `verify-commit.mjs` (D6, D11).
- Every operation registration and catalog skill, through the sweep (D6). Their meaning does not change, and the hedge count and the context budget hold it.
- `CLAUDE.md` — one line under "Other key patterns" naming the guard and this plan, once P3 lands.
- `NOTICE` — the MIT notice for the port (D5).

## 4. Phases

**P0 — This document and its index entry.** _Exit:_ the document is merged and `docs/plans/README.md` lists it.

**P1 — The linter is the repository's own.** D5, and the CLI's `scan`, with no gate.

- _Goal:_ a TypeScript port of the structural linter, and its first measurement of every Strict surface.
- _Criteria:_ the port's findings match `ste-lint.py`'s on the same corpus, and the plan records the numbers it measured.

_Exit:_ every `ste-lint.py --selftest` case has a twin test that passes, "may have failed" among them. Over the corpus of §1's table, the port's count for each rule equals the Python count, or this plan names each difference and why. The plan records P1's measurement of the field descriptions and the error templates, and the Flavored rate on plans 315 to 333.

**P2 — A fix round records its cause.** D8.

- _Goal:_ the loop's measure counts fix rounds by cause, so the brief's cost becomes a number before anything tries to lower it.
- _Criteria:_ a fix round caused by a misread brief is counted under `brief_reading` only when its quote matches the brief word for word.

_Exit:_ on the live stack, a commission briefed with a sentence that permits two readings, reviewed with the brief, yields a `brief_reading` finding whose quote matches. The loop's measure counts its fix round under that cause, and a finding with a paraphrased quote is not counted. The plan records the first window's counts as the before-number for P5.

**P3 — Strict surfaces are guarded.** D6's guard and baseline, with no rewrite.

- _Goal:_ no Strict string gets worse, and none is added with a finding.
- _Criteria:_ the guard fails on any rise in a unit's count and names the unit, the field, the rule and the words.

_Exit:_ the committed baseline equals P1's measurement unit by unit. A semicolon added to one pitfall of one operation fails the guard, naming the operation and the pitfall. A fix in one unit and a regression in another, in one change, also fails. A new operation with a 30-word description fails.

**P4 — Strict surfaces reach zero.** D6's sweep, a package at a time, each package its own pull request.

- _Goal:_ every operation, catalog skill and brief sentence has no hard finding, with every fact and hedge kept.
- _Criteria:_ every hard count in the baseline is zero, no unit has fewer hedges, and no Helmsman tool component has more tokens.

_Exit:_ every unit's hard count in the baseline file is zero, and the guard fails on any new hard finding. The hedge count of every unit is at least what P3 recorded. `scripts/context-budget/cli.ts check` passes with no tools component larger than in its baseline before the sweep.

**P5 — The brief teaches.** D7.

- _Goal:_ the Helmsman reads the structural findings of the brief it wrote, with the result of the commission it started.
- _Criteria:_ a brief with findings runs to its end and returns them, and a clean brief returns none.

_Exit:_ a brief made only of violations runs to completion, and its result names each finding. Its violations are semicolons, a 40-word sentence, and "check" and "verify" for one action. A clean brief returns an empty `briefFindings`. No brief is refused or delayed on its prose. The plan then records brief-caused fix rounds per commissioned node, before and after this phase. Each side needs at least 20 review-driven fix rounds.

**P6 — Local Code Review reads prose.** D9.

- _Goal:_ a review returns the structural findings of the Markdown a range adds, without letting them decide anything.
- _Criteria:_ prose findings appear as `proseFindings` at their lines, and the verdict and the publication's decision are the same with or without them.

_Exit:_ a range that adds a Markdown paragraph with a semicolon returns a `prose` finding at that line. The same range without the semicolon gets the same verdict, and a publication over it makes the same decision. A range that adds a line to `CLAUDE.md` is linted in Strict mode.

**P7 — New plan text is held to Flavored rules.** D11.

- _Goal:_ new plan prose cannot get worse than the measured rate, and the archive stays as written.
- _Criteria:_ the check fails a plan change above the baseline rate and reads no line the change did not add.

_Exit:_ a change that adds 400 words of plan prose with a semicolon in every sentence fails `scripts/verify-commit.mjs`. A change that edits one line of plan 315 reads that line alone. A change under 300 words is reported and passes.

**P8 — Reports and notes have a skill.** D10.

- _Goal:_ the Helmsman can have a report or a node note rewritten in Flavored mode without a prompt rule.
- _Criteria:_ the skill returns a rewrite that keeps every fact and hedge, and its findings never fail the run.

_Exit:_ the skill is contract-valid (Plan 190). Given §1's sentence from `workflow.run.list`, it returns text with no hard finding and the same facts. Given "the push may have landed", it keeps "may". A rewrite that still has findings completes and returns them. For one week of the operator's space, the plan records how many reports and notes went through the skill. It records their hard findings per 1,000 words beside those of the rest.

## 5. How it is proven

- **A hedge survives.** The port's test that "may have failed" passes clean fails if any rule reaches a modal. The P4 hedge count fails a sweep commit that turns "may have landed" into "landed".
- **The guard bites one unit at a time.** P3's exit: one semicolon in one pitfall fails and names it, and a fix elsewhere does not pay for it. A guard that summed the repository would pass that case.
- **The brief is never refused.** P5's exit: a brief that breaks every rule completes. A design that gated on the lint fails it on the first run.
- **Prose cannot decide a review.** P6's exit: the same range with and without a prose finding gets the same verdict and the same decision.
- **The effect is measured, not claimed.** The plan claims an effect only from two numbers, and names where each lives:
  - Fix rounds caused by brief ambiguity: `fixRounds` in the loop's measure, `GET /v1/spaces/:spaceId/plan/loop` (`readPlanLoopMeasure`). It counts from the round records on the plan nodes. Those are the commission runs linked to a node and the review runs whose findings they answer. Each finding's `kind` and `briefQuote` are in its review run's result. With fewer than 20 review-driven fix rounds on either side of P5, the plan records the counts and claims nothing.
  - The linter baseline on the agent-facing strings: `scripts/controlled-english-baseline.json`, read with `node --import tsx scripts/controlled-english/cli.ts scan`. P4's exit is every hard count in it at zero.
- **This document holds itself to D11.** `ste-lint.py --disable synonym-rotation` reports no hard finding in it. Its advisory findings, passive voice and compound tenses, stay as D2 allows.

## 6. Open questions

- **Terms across units.** `guardrail.policy.get` says "Retrieve a guardrail policy". The operation's verb and its description name one action with two words, and no unit-scoped check sees it, because the id is not prose. Whether the operation id's verb joins its unit, or a glossary of verbs becomes a lexical direction, is P4's first decision.
- **Error messages composed outside `packages/schemas`.** Executors build messages at run time from values the guard cannot know. D6 covers the templates `packages/schemas` exports. Whether the executors' messages move into templates, or stay outside the guard, is decided when P4 reaches them.
- **Notes as Strict text.** A node note is read by the next session before it writes a brief (`plan.node.get`). If P2's counts show `brief_reading` findings that quote words copied from a note, notes move to Strict mode.
- **Instructions at 20 words.** STE caps an instruction at 20 words and a description at 25. The linter cannot tell them apart and applies 25. Whether pitfalls, which are instructions, take 20 is measured in P4, not assumed.
