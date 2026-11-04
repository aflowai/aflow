# Plan 341 — The machine is measured

**Status:** P0 is approved. P1's harness runner and evaluation writer are built, and its pilot has not run. The pilot's arm (b) is one commission without review rounds (D3). P2's review rounds serve arm (b) from P2 on. They are built, and P2 has not run. P3 and P4 are not built.

**Builds on:** Plan 269 (the eval plane: one evaluation substrate, `workflow_runs.evaluation_json`, frozen replays), Plan 329 (planning is a skill), Plan 183 and Plan 234 (the learning loop), Plan 315 (the local loop), Plan 337 (the decision card), Plan 333 (D2's writing rules). Plans 269, 329, 183 and 234 predate the published archive, which starts at Plan 315, so they are cited by number and not quoted.

**Leaves alone:** the loop skills' behaviour, and Plan 342, named below as the follow-on and not designed here.

## Decision card

**What changes**

- Today: the loop has built itself for weeks with no number saying how good it is. Planning, autonomy, memory and learning change by judgement alone.
- After: the loop is scored on SWE-bench Pro through the official harness. Phase results decide what to improve in planning, autonomy, memory and learning.

**Why**

- The loop drives every change in this repository, and nothing measures whether its planning, memory and learning help.
- A public instrument puts the machine's number beside published agent scores.
- Plan 269's evaluation plane needs real work to measure. This plan supplies it.

**What it affects**

- A new measurement space, Proving Ground, separate from Full Circle.
- A new harness runner and evaluation writer in Proving Ground, landed in P1.
- A new platform skill, Review Rounds, landed in P2. It runs arm (b)'s review rounds from P2 on.
- The loop skills, measured and not changed.
- This plan document, which holds a results table per phase.
- The host folder bindings and the compute where task images run.

**Risks**

- A benchmark task's repository may not run as a folder the loop can work. Mitigation: the pilot proves the mechanics on eight tasks before any spend at scale.
- Task images may not run on the Mac one at a time. Mitigation: the hosted compute worker is the named alternative, and the open question below settles it for the pilot.
- Learning may leak across arms and inflate the learning gain. Mitigation: a separate space per arm, or learnings scoped to the arm's run set.
- Third-party aggregator scores are unverified. Mitigation: only Scale's own leaderboard is cited, and no aggregator score enters the plan. Several aggregator scores in circulation are unverified and must not be cited anywhere in this document.

**Open questions**

- Which host runs the task Docker images? Answer: the Mac, one at a time under the check lane's load rule, for the pilot. The GCP compute worker if the pilot shows the Mac is too slow.
- What caps one task's spend? Answer: a cap in tokens and wall time at twice the pilot's measured median per task.
- How is arm (c) isolated from arms (a) and (b) so no learning leaks across arms? Answer: learnings scoped to the arm's run set. It is the lighter of the two options, and every arm stays in Proving Ground as D5 names it. A separate space per arm is the fallback if the scoping leaks.
- Which cost figures count? Answer: model tokens only for the first table. CI minutes and compute join once the pass rates are read.

**Not done on purpose**

- The loop skills' behaviour is not changed until a number says what to change.
- Plan 342, MLE-bench Lite, is named as the follow-on and not designed here.
- No pull request is opened for a benchmark task. The patch is the output.
- No judge scores a task. The official harness is the only grader.
- No planning hierarchy is built before P4 shows it is needed.

**Done when**

- The pilot's results table is in this document, with pass rate, tokens, cost, wall time and failure classes per arm.
- Each later phase's results table is in this document as it lands.

## 1. The problem

The loop has built itself for weeks without a number saying how good it is. The loop is these parts:

- A Helmsman plans nodes.
- Commission Change runs a coding harness on a folder.
- Local Code Review reviews the change in rounds.
- Local Publish and the Local PR Shepherd land pull requests.
- Learnings accumulate from each run.

Planning, autonomy, memory and learning have changed by judgement alone. A number against a public instrument is what turns those judgements into decisions.

## 2. The decisions

### D1 — The instrument is SWE-bench Pro

SWE-bench Pro is Scale AI's standardized public set. It holds 1,865 tasks across 41 repositories in Python, Go, TypeScript and JavaScript. Hidden tests grade each task in the official Docker harness.

Scale's own leaderboard is the only score source the plan cites.

_Rejected:_

- SWE-bench Verified. OpenAI retired it in February 2026 as contaminated and near ceiling, with flawed tests on a share of its hardest tasks.
- Terminal-Bench 2. It is near saturation, and it measures shell skill rather than the quality of a change.
- SWE-Lancer. It is stale, and it is not built for a process-versus-harness comparison.

### D2 — Three arms, one model

All three arms use one model, the model the loop uses today:

- (a) The bare coding harness, given the task text.
- (b) The loop: a node, Commission Change, review rounds to approve or to the rounds rule, and the patch taken at the end.
- (c) The loop with learnings and memory on. Tasks run in chronological order, so a later task can use what an earlier one taught.

The score is the hidden-test pass rate from the official harness, never a judge. (b) minus (a) is what the process adds. (c) minus (b) is the learning gain, with forgetting read the way SWE-Bench-CL reads it.

_Rejected:_ a judge-scored rubric. Plan 269 holds judges advisory until measured.

### D3 — A pilot before any scale

P1 runs eight tasks drawn at random from the standardized set with a fixed seed. It runs one seed and arms (a) and (b) only. Its arm (b) is one commission without review rounds, because the rounds land in P2. Its patch is taken as the commission left it. It measures these figures:

- Pass rate per arm.
- Tokens and cost per task per arm.
- Wall time per task per arm.
- The failure classes.

It proves the mechanics:

- A task's repository and image work as a folder the loop can work.
- The patch is captured.
- The official harness runs on the patch.
- The result is recorded.

The pilot's job is the price of a task and a working pipeline, not a conclusion.

_Rejected:_

- Starting at 50 to 100 tasks. A mechanics failure at that size wastes the spend.
- Running the pilot's arm (b) with review rounds, by building the rounds first. The pilot's job is the price of a task and a working pipeline. The rounds did not exist, and building them before any measurement would have delayed the pilot's spend without informing it.

### D4 — Scale after the pilot

- P2 runs 50 to 100 tasks across three arms and three seeds, with intervals on every difference.
- P3 runs the learning arm in chronological order, with memory on against memory off.
- P4 measures long-horizon trust on SWE-Marathon. It holds 20 multi-hour tasks, where frontier agents score under 30 percent.

P4 is also where a need for recursive planning would first show. So no planning hierarchy is built before P4 shows it is needed.

_Rejected:_ building recursive planning first. No measurement has yet shown a task the loop fails for want of it. Building it first would spend effort on a need P4 may never show.

### D5 — Where it runs

The measurement runs in a space of its own, named Proving Ground, not in Full Circle.

- Each task gets a folder through the host executor's folder binding.
- The task's Docker image runs where the machine allows. The hosted compute worker is the alternative.
- No pull request is opened for a benchmark task. The patch is the output.

The publication and shepherd skills stay out of the measurement on purpose.

_Rejected:_ running the measurement inside Full Circle. The loop's own work and its measurement would then share one space's learnings and attention.

### D6 — Results are platform records

Each task attempt is a workflow run. Its evaluation envelope carries the official result, written through Plan 269's one writer. The board, the learnings and the Coach read the same numbers.

A results table lives in this document per phase.

_Rejected:_ results held in files beside the plan. The board and the Coach cannot read them there.

### D7 — What the plan leaves alone

The loop skills' behaviour is measured, not changed, until a number says what to change.

Plan 342 measures the same machine on MLE-bench Lite. It brings 22 Kaggle competitions, medal thresholds and published agent scores to compare against. A live Playground Series competition serves as a smoke test only. Plan 342 seeds the research and problem-solving skill bundle from what it finds.

Plan 342 is named here as the follow-on and is not designed here.

_Rejected:_ designing Plan 342 now. Plan 341's numbers do not exist yet to shape it.

## 3. What it affects

- A new space, Proving Ground, and its host folder bindings, one per task (D5).
- The compute choice per task image: the Mac for the pilot, or the hosted compute worker (D5).
- A harness runner in Proving Ground. It captures each task's patch and runs the official SWE-bench Pro Docker harness on it (D3, D5).
- An evaluation writer in Proving Ground. It writes the official result through Plan 269's one writer (D6).
- A platform skill, Review Rounds, in an unlisted bundle Proving Ground installs. It runs arm (b)'s review rounds with nothing pushed, from P2 on (D2, D5).
- The evaluation envelope, written once per task attempt through Plan 269's one writer (D6).
- This document's results tables, one per phase (D6).
- The loop skills, measured and not changed (D7).

The loop's skills are unchanged. The measurement machinery is new: the harness runner and the evaluation writer from P1, and the Review Rounds skill from P2.

## 4. Phases

Each phase lands on its own.

**P0 — This document and its index row.** _Exit:_ the operator approves it, or amends it and then approves it.

**P1 — The pilot (D3).** It lands the harness runner and the evaluation writer, and proves them on eight tasks. _Exit:_ the results table is in this document, and the mechanics are proven end to end on all eight tasks.

P1's machinery is the harness runner and the evaluation writer. It is built, and the pilot has not run. It holds no review rounds, so P1 does not run D2's arm (b) whole.

D3 sets the pilot's arm (b) as one commission without review rounds. Its patch is taken as the commission left it. Its number measures a node and one commission, not the loop's rounds. The rounds land in P2 and serve arm (b) from P2 on.

The machinery's pieces are these:

- The harness runner is `yarn bench:swe-pro`, a development script beside the loop's own measurement. It fetches a task's repository up to its base commit, captures the patch against that commit, pulls the task image and runs the official harness with local Docker.
- A materialized folder's history ends at the base commit. It has no remote and no tag, so no ref in it reaches a later commit or the gold fix.
- `designate` marks Proving Ground as the measurement space, under `benchmarkMeasurement` in the space's metadata.
- `attempt` runs arm (a) whole. It creates the attempt's workflow run in Proving Ground, marked under `benchmarkAttempt` in the run's metadata.
- Arms (b) and (c) run between `materialize` and `grade`, with the folder bound to Proving Ground through the host lane. `grade` records on the loop's run named by `--run`, and takes the loop's outcome as `--agent-outcome`.
- The evaluation writer is `writeBenchmarkAttemptEvaluation` in `@aflow/cybernetic-runtime`. It refuses a run outside the measurement space before any write. It also refuses an eval-batch trial and a run marked as another attempt.
- The writer writes through `writeRunEvaluationEnvelope` into the envelope's `benchmark` slot only. A production suite's `decision` and `summary` on the same run stay as the suite wrote them.
- A bare-harness run records the decision `no_suite` when the runner creates it, because no post-run hook fires for it.
- The writer refuses a loop run in a space with directives that has recorded no decision yet. The envelope repair finds only NULL envelopes, so the run would otherwise never record its Plan 269 decision.
- A declined write prints the verdict the run holds and says the new verdict was not stored.
- `benchmarkVerdict` reads the slot as `pass`, `fail` or `unscored`. An attempt the harness gave no verdict on is `unscored`, so a broken pipeline cannot lower a pass rate.
- Tenant, space, work root and harness checkout are flags with no default.

**P2 — Scale (D4).** _Exit:_ pass rates with intervals for all three arms are in this document.

P2 lands the review rounds, and they are built. They serve arm (b) from P2 on, and arm (c) when it runs. The rounds are the operator's: a review, its fix rounds and the rounds rule, run on a folder's patch with nothing pushed. D5 keeps the publication out of the measurement, so the rounds cannot live inside Publish Local Changes. Its pieces are these:

- The mechanism is a platform skill, Review Rounds (`review-rounds`), in the unlisted bundle `local-review-rounds`. Proving Ground installs it. The Coding Loop does not carry it, so Full Circle's loop is unchanged.
- A commission goes in by its run id, with the brief it ran on and a new branch name. The skill reads the commission's `patchRef`, `baseSha` and `summary` from its run.
- Each round commits on a local branch with `host.file.patch` and no `pushBase`. Nothing is fetched or pushed, and the folder needs no remote.
- Each review is Review Local Changes, started as a run of its own, as the publication starts it. It reads `baseSha..<head>`.
- Each decision is `workflow.run.decide` over the publication's own rule builders, with its decision names. Round 1 with a minor or worse takes a fix round. Later rounds with minors or nits take the patch as it stands. A major or a blocker always takes its fix. No model is asked.
- A fix round is Commission Change on the local branch, briefed with the brief and the review's summary.
- The skill takes any brief Commission Change takes. It does not narrow the brief to fit a fix round. A fix round adds a bounded opening, a separator and the review's summary, which Review Local Changes bounds.
- Before each fix round, a `workflow.run.decide` counts the fix brief's characters with the `$length` template operator. It counts the fix round's inputs in bytes with `$jsonBytes`. A fix brief past Commission Change's limit, or inputs past the 32 KB cap, stop the rounds at `fix_brief_too_long`. A `fix_failed` stop therefore never means a brief too long.
- The rounds stop at three reviews, the operator's limit.
- A last `workflow.run.decide` records `stoppedAt`: the round that ended the rounds, and why. `taken_as_it_stands` and `round_limit` are ends the rounds rule chose. `fix_brief_too_long` means a fix brief would not fit. `fix_failed`, `fix_no_patch`, `commit_failed` and `review_failed` name a step that broke. A commit task is optional, so a refused commit stops the rounds at `commit_failed` as a conflict does. `commission_not_completed` means the commission failed, was cancelled or is still running. `no_patch` means the completed commission had no patch. The last round's `decision` cannot say this, because a broken fix round leaves it at `fix_before_merge`, as the limit does.
- The run records every round as a task, with each review as a run of its own. Each decision states its reason. The `rounds` output holds each round's verdict, findings, review run and head. After a decided round, the final `headSha` is the last head a review read and the rule decided.
- Every stop after a completed commission leaves a `headSha`, and `stoppedAt.reason` names which head it is. Where round 1's review decided nothing, it is the commission's own commit, which no review read. Where no commit landed, it is `baseSha`, and it grades as an empty patch.
- The driver grades that head with `grade --ref <headSha> --run <the rounds run>`, so the attempt's verdict lands on the run that shows its rounds.

The publication's rule differs in two cases and stays as it is. A reader of arm (b)'s results reads the loop's process through both:

- After its fix round, the publication publishes an approving review's major, because its push gate then asks the operator. No operator stands behind a benchmark patch, so here the major takes its fix.
- After its fix round, the publication fixes a review that does not approve and has no blocker or major. Here that review is taken as it stands, its minors and nits recorded open.

_Rejected:_

- A rounds loop inside the benchmark runner. Its decisions would live in a script, where the board and the Coach cannot read them (D6).
- Moving the rounds out of Publish Local Changes. That changes a loop skill to serve the measurement, which D7 rules out.
- A model deciding the rounds. The publication decides them by rules because no measured model cleared the bar (Plan 316 §7), and a second judge would make the arms differ by more than the process.
- Capping the rounds' brief input below Commission Change's limit. It narrows an input to fit a downstream cap, which CLAUDE.md forbids. It also made a task with a longer brief unreviewable.
- Capping the composed brief by construction, so that a bounded accepted brief always fits. It lost for the same reason. It narrows the input rather than bounding what the fix round adds.

**P3 — The learning arm in order (D4).** _Exit:_ the learning gain, with forgetting read, is in this document.

**P4 — Long-horizon trust (D4).** _Exit:_ the SWE-Marathon results are in this document, with what they say about recursive planning.

## 5. How it is proven

The pilot's mechanics proof is the case. Each of the eight pilot tasks of D3 runs end to end:

- Its repository and image work as a folder the loop can work.
- The patch is captured.
- The official harness runs on the patch.
- The pass or fail is recorded as a platform record.

A measurement that cannot show that chain for all eight tasks has failed, whatever the pass rate says.
