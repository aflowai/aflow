# Plan 321 — The loop recovers from CI

**Status:** 📋 planned — nothing built; start at P0

**Builds on:** Plan 315 (the loop: commission → review → publish; `mergeFrom`; the push posture), the catalog's `pr-shepherd` skill (the hosted code lane's shape of the same job), the scheduler (`agent.schedule.create`), and the `github` connector.

## 1. Problem

The loop ends at the push. Local Publish commits, scans, reviews and pushes, and opens the pull request; what happens to that pull request afterwards is read by a person. In the first week of running the loop on this repository, three pull requests failed CI after an autonomous push — a flaky timing test, a dependency advisory that arrived between two pushes, a merge conflict with `main` that the PR workflow refused to run on — and each was found by the operator, diagnosed by hand, and fixed by a brief written by hand. The always-on target of Plan 315 has a hole exactly there: nothing on the platform notices a red check, and nothing turns it into a commission.

A shepherd that does this starts cold every time. A scheduled run is a new session with no memory of the last one, in a space where other work is in flight: a publication of the same branch may be paused at its approval, a commission for the same pull request may be running under another operator's conversation, a review may be about to return. A shepherd that reads only the pull request will commission a fix for a failure another run is already fixing, re-fix the same failure on every firing, or push onto a branch while a person is working on it. The platform has the pieces — `workflow.run.list_attention`, the handoff comment the hosted `pr-shepherd` leaves on a pull request, the memory store — and no skill that composes them into "what is happening to this pull request right now".

What the hosted `pr-shepherd` already settles: one invocation is describe → rehydrate → decide → fix / merge / abandon / wait → handoff; the handoff comment on the pull request is the durable record the next invocation reads; the fix runs on the existing branch; review and learning happen outside the skill. What it cannot do here: it runs on the hosted code lane (`code.agent.run`, `code.repo.push`), which the local edition does not have, and its idea of "in flight" is the handoff alone.

## 2. Decisions

**D1 — The shepherd is a skill, run by the Runner, and every decision it makes is read from data.** `local-pr-shepherd` is a catalog skill on the host lane: it finds the pull requests the loop opened, reads each one's live state, decides `fix | wait | abandon | leave`, and for `fix` commissions the coding agent on the pull request's branch with `base: <branch>` and `mergeFrom: origin/<base>` and publishes the result appended, through Local Publish, under the folder's posture. No step of it is a Helmsman conversation. _Rejected:_ a Helmsman prompt that says "check the pull requests" — a cold session with prose instructions is the shape that commissions duplicate work; what a cold run needs is the state as inputs to its tasks (D3), not a paragraph about being careful.

**D2 — The trigger is a schedule on the local edition, and a webhook later where there is a public address.** A recurring schedule (`agent.schedule.create`, `cron`) fires the skill every few minutes while the executor is paired; the interval is an operator knob with a default measured in P0 against GitHub's rate budget, not a constant chosen here. The firing carries nothing but the connected folder: the skill discovers its pull requests itself. The appliance's own webhook ingest is the hosted edition's trigger, where `api.aflow.ai` can receive GitHub's `check_suite` events; a laptop cannot, so it polls. A recurring schedule's `maxFirings` is finite by design; the skill's last task renews the schedule when it is near its cap, so the shepherd does not expire silently.

**D3 — A cold run reads four things before it acts, and acts on none it did not read.**

1. **The pull requests that are its to tend**: open pull requests whose head branch is under the folder's publish prefix and whose body carries Local Publish's marker. A pull request a person opened, or one labelled `hands-off`, is left alone.
2. **The head's checks**: `listCheckRuns` on the head sha. The decision reads the conclusions, not the names.
3. **The handoff**: one comment per pull request, `<!-- aflow:shepherd -->`, carrying `attemptCount`, the `checkRunId` of the last failure acted on, the head sha it acted on, and the run id of the fix it commissioned. Written by the shepherd alone.
4. **The space's in-flight work on that branch**: a lease in the memory store, `shepherd/<owner>/<repo>/<branch>`, taken for the duration of a fix and released at its end, holding the run id and the time; and the space's attention list (`workflow.run.list_attention`) for a paused publication or commission naming that branch. A branch with a live lease or a paused run on it is `wait`, whoever started that run — a person's conversation included.

The four reads are tasks with typed outputs, and the deciding step receives them as its inputs. A read that fails ends the run as `wait` with the reason, never as a guess.

**D4 — Same failure, same answer: a check run is acted on once.** A failing check whose `checkRunId` equals the handoff's is `wait` — CI has not re-run since the last fix, or the fix is still being published. A new failing check run on a head the shepherd already pushed increments `attemptCount`; at the budget (three, an operator knob) the shepherd posts why it stopped and raises one Action Center item, and leaves the pull request alone until a person moves it.

**D5 — The fix brief is assembled, not written.** The commission's task is built from data: the pull request's title and body, the failing jobs' names and the last part of each failing job's log (`listWorkflowRunJobs` and `getJobLogs` join the `github` connector; the excerpt is bounded and stored as a payload the task references), the handoff's record of earlier attempts, and the standing rules every commission carries (the checks to run, no process started, nothing under `.aflow/`). A conflict with `main` is not a fix the shepherd writes: with `mergeFrom`, the commission starts on the merged tree and resolves it (Plan 315 D15), and the publication folds it into one merge commit.

**D6 — The shepherd never approves, merges or closes.** It pushes only through Local Publish, under the folder's posture, so an unclean scan or a `request_changes` still asks the operator; it holds no grant and cannot mint one (Plan 253). Merge-on-policy is the next plan, not this one; `abandon` is a comment and an Action Center item, not a closed pull request. _Rejected:_ the hosted skill's `merge` branch with an HITL gate — the local loop's rule is that the merge is the operator's until a policy says otherwise, and that policy is not written.

**D7 — What a person asks Helmsman is answered from the same records.** "What is the shepherd doing" is `workflow.run.list_attention` plus the handoff comments, surfaced in the space context as the shepherd's recent decisions per pull request. Helmsman gets no prose about the shepherd; it gets the records.

## 3. Design

### 3.1 Tasks

| Task             | Operation                                                                | Reads / does                                                                                |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `read-folder`    | `host.binding.inspect`                                                   | the branch prefix, the posture, `origin`                                                    |
| `list-prs`       | `api.http.call` `listPullRequests`                                       | open pull requests, filtered to the prefix and the marker, minus `hands-off`                |
| `read-pr`        | per pull request: `getPullRequest`, `listCheckRuns`, `listIssueComments` | head sha, checks, the handoff                                                               |
| `read-in-flight` | `memory.store.get`, `workflow.run.list_attention`                        | the lease and any paused run on the branch                                                  |
| `decide`         | `ai.generate_json` or a pure rule                                        | `fix \| wait \| abandon \| leave`, with the reason; a rule where the inputs decide it alone |
| `read-failure`   | `listWorkflowRunJobs`, `getJobLogs`                                      | failing jobs and bounded log excerpts, as a payload                                         |
| `lease`          | `memory.store.put`                                                       | the lease, written before the commission                                                    |
| `fix`            | `host.harness.run`                                                       | `base: <branch>`, `mergeFrom: origin/<base>`, the assembled task                            |
| `publish`        | `workflow.run.start` Local Publish                                       | appended onto the branch, `wait: 'until_complete'`                                          |
| `handoff`        | `createIssueComment` / edit                                              | the updated record, every pass                                                              |
| `release`        | `memory.store.delete`                                                    | the lease, on every terminal path                                                           |
| `renew`          | `agent.schedule.create`                                                  | the next schedule when this one nears `maxFirings`                                          |

Whether `decide` needs a model at all is a P0 question: the inputs above decide the four outcomes without one, and a model is reached for only to read a log excerpt a rule cannot.

### 3.2 What is recorded

Every pass leaves the handoff current and one run in the ledger. A `fix` also leaves the commission's and the publication's runs, linked from the handoff by id. A pass that found nothing to do leaves only its run.

## 4. What it affects

- `packages/platform-artifacts` — the `local-pr-shepherd` skill and its bundle; `listWorkflowRunJobs` and `getJobLogs` on the `github` connector; Local Publish's body marker.
- `packages/schemas` — nothing new unless P0 finds the attention list cannot name a branch, in which case a bounded read of a space's runs by workflow and input field.
- `packages/web-product` — the shepherd's recent decisions in the space context (D7).
- `docs/dev/driving-work-through-the-loop.md` — a stream that wants a branch left alone labels its pull request `hands-off`.

## 5. Phases

**P0 — Measure.** How a fired schedule starts a skill run and what input reaches it (`scheduleCrud`); GitHub's rate budget against the polling interval; the size of a failing job's log and the excerpt that carries the failure; whether `workflow.run.list_attention` can name a branch. _Exit:_ each answer in this plan with the command that produced it.

**P1 — One pass, by hand.** The skill with `read-*`, `decide`, `handoff` and `release`, fired manually against a pull request with a planted failing test; `fix` and `publish` land it. _Exit:_ the planted failure is fixed and pushed within one pass without a hand; a second pass on the same check run is `wait`.

**P2 — Cold and concurrent.** The schedule, the lease, `hands-off`, the budget and `abandon`. _Exit:_ two firings overlapping on one pull request produce one fix; a branch with a paused publication is `wait`; a labelled pull request is untouched; the fourth failure on one pull request ends in a comment and an Action Center item.

**P3 — Seen from the space.** D7 in the space context; the stream protocol updated. _Exit:_ Helmsman answers "what is the shepherd doing" from records alone.

Deferred, not planned here: merge-on-policy; the webhook trigger for the hosted edition; a shepherd for review comments a person leaves on the pull request.

## 6. How it is proven

- **It fixes what CI failed**: a planted failing test is fixed and pushed within one pass, with no hand.
- **Once per failure**: the same `checkRunId` twice is `wait`; the handoff shows one attempt.
- **Never two at once**: two firings in the same minute on one pull request leave one lease, one commission, one publication.
- **It yields to people**: a paused publication, a running commission or a `hands-off` label on the branch is `wait`, by one test parameterised over the three.
- **It approves nothing**: the publication it starts asks exactly where Local Publish asks on its own; a planted allowed-line secret still pauses for the operator.
- **It stops**: the budget reached is a comment, an Action Center item and no further commission.

## 7. Open questions

- Whether the lease belongs in the memory store or on the pull request itself, as a label the shepherd sets and clears; the store is private to the space, the label is visible to a person on GitHub.
- Whether a person's `request_changes` review on the pull request should feed the same `fix` path, with the review comments as the brief's data. The hosted `pr-shepherd` says yes; this plan starts with CI alone.
