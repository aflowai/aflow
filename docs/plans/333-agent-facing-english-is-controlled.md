# Plan 333 — Agents are told the shape of the English they write

_The file name predates the re-cut and is kept so existing links hold._

**Status:** 🔨 P0 merged (PR #220). P1 built: the guidance block is in the four places D2 names. P2 remains optional and blocked until the operator approves it.

**Builds on:**

- Plan 324: the emitted tool description is `semanticDescription` plus the operation's first `whenToUse`.
- Plan 322: plan nodes and their notes.

**Source:** the rule categories of [`danyuchn/asd-ste100-skill`](https://github.com/danyuchn/asd-ste100-skill) (MIT, v0.4.0, commit `8da6b63`). That skill borrows them from ASD-STE100 Issue 9.

## 1. Problem

Every agent in Aflow acts on English it cannot ask about. The Helmsman chooses a tool from its `semanticDescription` and `usage`. It reads a result through the descriptions of its output fields, and it recovers from an error by its message. The coding agent carries out a brief the Helmsman wrote. Nothing in the repository says what shape that English takes, and nothing checks it.

- **A misread brief costs a round.** A commission runs thirty to forty minutes (`COMMISSION_TIMEOUT_DEFAULT_MS`, `commissionChange.ts`). The coding agent can take a reading the brief's words allow and the node did not mean. Review then finds it, the publication decides `fix_before_merge`, and a fix round runs: a second commission, a second review. Nothing reads the brief before the coding agent does.
- **Nothing records why a round happened.** The board counts a node's rounds (`PlanTreeNode.rounds`), and the loop's measure counts operator actions and cost. No record says what caused a fix round. So the cost of brief wording is unknown today. This plan leaves it unknown. The operator judged a measure of round causes over-engineered for the goal, and accepts the cost of a misread brief without measuring it (D3). So this plan claims no drop in rounds.
- **The catalog prose is long and joined by semicolons.** The table below is `ste-lint.py` run over this repository at `1b0835a8`. It read one file per operation and per catalog skill, so a synonym check covers one unit. Of the 206 operations offered to agents as tools, 53 have a semicolon in `semanticDescription`. The longest sentence in one is 64 words (`workflow.run.list`). A pinned tool carries that description in every turn (Plan 324), so a sentence the model must parse twice costs context in every turn.
- **One unit names one action with several words.** `ste-lint.py` flags 26 synonym rotations in the operations and 5 in the skills. `api.binding.test` says "check", "validate" and "verify". `api.http.call` says "get" and "fetch". The reader cannot tell whether the text describes one action or several. Some flags are two distinct actions.
- **The rules exist only as taste.** `CLAUDE.md` teaches by example how to write for an agent. No check reads the shape of the text, so a pitfall with three semicolons merges as easily as one with none. This plan writes the rules down (D2) and adds no check (D3), so that stays true.

| Surface                                                                                                 | Units | Words  | Hard findings | Semicolon | Sentence over 25 words | Synonym rotation | Marketing adjective, phrasal verb, nominalization | Advisory: passive, compound tense |
| ------------------------------------------------------------------------------------------------------- | ----- | ------ | ------------- | --------- | ---------------------- | ---------------- | ------------------------------------------------- | --------------------------------- |
| Operations: `semanticDescription`, `usage.whenToUse`, `usage.pitfalls`                                  | 229   | 25,610 | 409           | 205       | 178                    | 26               | 0                                                 | 266, 23                           |
| Skill catalog: tagline, descriptions, `usage`, run-input descriptions, output guidance, activation hint | 20    | 13,016 | 324           | 129       | 190                    | 5                | 0                                                 | 137, 11                           |

Marketing adjectives, soft phrasal verbs and nominalizations measured zero on both surfaces. Catalog prose was expected to hold marketing adjectives, and it holds none. Field descriptions on operation inputs and outputs, and error messages, are not in these numbers.

## 2. Decisions

The goal is text that agents write so that the next reader reads it fast and in few tokens. Compliance with a rule set is not the goal. On 2026-10-29 the operator decided that agents get the expected format briefly, and that nothing checks it.

**D1 — The result is STE-inspired, never STE-compliant.** Three things stop it from being compliant, and all three are deliberate.

1. The approved-word dictionary is absent. ASD-STE100 is free to obtain and not free to redistribute. Issue 9 grants reproduction only to listed categories of organisation, and Aflow is in none of them.
2. Present perfect stays where it carries meaning. "The commission has ended" says its result is available now. "The commission ended" says only that it ended at some time. Status text needs the first.
3. Hedges survive every rewrite, and nothing flags them. The platform often reports what it does not know. A push may have landed, or a check may have run out of time. The secret scan's own pitfall says "A clean scan says no rule matched, not that the range holds no secret." The Helmsman's next decision turns on that doubt. A rewrite that turns "may have pushed" into "pushed" skips the look at the branch that was needed. A rewrite that turns it into "did not push" starts a second push.

_Rejected:_ calling the result compliant. Compliance cannot be verified without the dictionary, and a reader would trust the word. _Rejected:_ obtaining the dictionary for the repository. A word list the repository cannot publish is a rule its contributors cannot follow.

**D2 — The rules are a short guidance block, written once and placed where each writer reads it.** The block carries the structural rules only:

- No semicolons. Write two sentences.
- Keep each sentence under about 25 words.
- Use one verb, not a nominalisation: "analyse", not "perform an analysis of".
- Use no soft phrasal verbs: "find", not "figure out".
- Use no marketing adjectives.
- Make each list item stand alone. Do not end one with "and" or "or".
- Inside one unit, use one word per concept. Do not say "check", "validate" and "verify" for one action.
- Keep every hedge. "May have pushed" stays "may have pushed".
- Keep the present perfect where it carries meaning.

The house voice holds: the system is the subject, and the text records decisions, not narrative. The block is placed in four places:

1. The Helmsman's system prompt (`packages/cybernetic-runtime/src/helmsmanPrompt.ts`), in the section for reports and node notes.
2. The harness result instruction (`apps/aflow-executor-host`, `composeHarnessTask` and `resultInstruction`). It shapes a commission's summary and the PR body.
3. Compose-skill's drafting instruction (the `draft-task-graph` goal in `packages/platform-artifacts/src/skillBundles.ts`), for the text a skill carries.
4. `CLAUDE.md`, for the local session and coding agents.

**D3 — Nothing checks it.** No linter, guard, baseline, findings kind, review operation, skill or verify-commit step reads the text, and nothing blocks a step over style. This is the one place where `CLAUDE.md`'s rule "Prompts are a last resort" yields. A writing style has no schema to live in, and the operator refused the machinery that would stand in for one.

**D4 — The catalog strings may be rewritten once by hand to the same rules.** This covers operation descriptions, pitfalls and skill prose. It is an ordinary change with no guard, optional and separate from P1. A rewrite keeps every fact, condition and hedge.

_Rejected_, as over-engineered for the goal:

- a linter port
- a per-unit baseline guard
- a lint on the brief
- a findings kind for prose
- a rate check on new plan text
- a skill that rewrites text plainly

## 3. Phases

**P0 — This document.** Done (PR #220, merged).

**P1 — The guidance block lands in the four places D2 names.** One small PR. Approved by the operator's decision of 2026-10-29.

**P2 — The catalog strings are rewritten once (D4).** Optional, and blocked until the operator approves it. One package per PR, with no guard.
