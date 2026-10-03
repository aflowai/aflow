# Driving a change through the loop

A change to this repository can be built by the platform itself: Helmsman commissions the
installed coding agent on the connected checkout, Local Code Review reads the range, and
Local Publish commits, scans, pushes and opens the pull request. The operator merges. This
page is the protocol every session that drives work this way follows, so two of them can
run side by side without taking each other's work down. Plan 315 is where the loop was
built and where its gaps are logged; the gaps that still bind are listed at the end.

## The pieces

| Piece            | Where                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Space            | Full Circle, `a28f0887-c84a-43ac-87e1-c984eae9d3b9`                                         |
| Connected folder | binding `hb_aflow` = `~/localhd/aflow`, branch prefix `aflow/`                              |
| Push posture     | `unless-unreviewed`: a clean scan plus a child review `approve` pushes without asking       |
| Folder checks    | `node scripts/verify-commit.mjs`, declared on `hb_aflow`; run by every publication first    |
| Commission       | the catalog's Commission Change, on `host.harness.run`, model `claude-opus-5-5`             |
| Review           | the catalog's Local Code Review, over `origin/<base>..<sha>`                                |
| Publication      | the catalog's Local Publish, by `patchRef`, onto `aflow/<branch>`                           |
| Pull requests    | opened through the space's GitHub binding; merged by the operator                           |
| Dev stack        | one, from `~/localhd/aflow-worktrees/live`, branch `live` = `main` plus branches under test |
| Driving client   | the `aflow-local` MCP server from `.mcp.json`, set up by `yarn mcp:setup`                   |

One Helmsman conversation per stream of work. A second stream starts its own conversation
in the same space; it never posts into another stream's conversation and never cancels
another stream's runs.

## A round

1. **Brief Helmsman**, one message, numbered. Part 1 is the commission: a run of the
   catalog's Commission Change started with `wait: 'none'`, so the conversation stays free
   and the commission's end wakes it with `patchRef`, `baseSha`, `merge` and `sessionRef`.
   Its inputs are the binding, the model, `base` (`origin/main` for new work, the branch's
   name for a fix appended to an open pull request, with `mergeFrom: origin/main` where
   `main` has moved past it), and `task`: the findings or the slice to build, each with
   the file, the line where it is known, what is wrong and what right looks like, and the
   tests to add. `harness` is needed only where the machine offers more than one coding
   agent. Its two hours, and the operation's several hundred turns on an agent that
   takes a turn budget, are sized for a slice; name `timeoutMs` or `maxTurns` only to
   change them. Several commissions may run at once, within the machine's limit (below).
   The checks the agent must run are named in the brief, because the folder's checks
   only run once the commission is published: `yarn test:file` on touched and added tests, `npx tsc -p` per touched
   workspace, the two CI guards (`scripts/large-files/cli.ts check`,
   `scripts/context-budget/cli.ts check`), `npx eslint` on touched sources, `npx prettier
--write` with the `--check` output in the result. The standing rules go in too: comments
   only for non-obvious whys, copy in the system's voice, no shims, nothing written under
   `.aflow/` but the result file, and the agent starts or stops no process. Part 2 is the
   publication, started once the commission's end has woken the conversation: by
   `patchRef`, `baseSha` the commission's, `mergeFrom` its `merge.from` where it merged, `base: main`, the branch, owner
   and repository, the title, started with `wait: 'none'`, and the run id reported back.
   For a branch that already has a pull request, name its number for the 422.
2. **Read the review**: `workflow.run.detail` on the child review run gives the verdict and
   every finding with file and line. `approve` means the publication pushed on its own;
   anything else leaves it paused at `approve-push`, and the next round is the fix.
3. **The publication runs the folder's checks.** `hb_aflow` declares
   `node scripts/verify-commit.mjs` (`aflow harness checks hb_aflow -- node
scripts/verify-commit.mjs`), and Local Publish runs it after the commit and before the
   scan, the review and the push, in a detached checkout of the commit with the folder's
   dependencies linked, under the coding agent's sandbox. The script reads what changed from
   `AFLOW_CHECK_BASE...AFLOW_CHECK_SHA` and runs, one line per step and stopping at the
   first failure: the two CI guards; a build of every package the touched workspaces
   or the workspaces reading a touched package reference or import, since a checkout builds
   nothing; `tsc -p` per touched workspace (and `web-product`'s `src/ui`); the touched tests
   through the test runner, reporting only failures and the summary, with every test of
   each workspace that reads a touched package, so a contract change meets its consumers
   before the push — such a package built first, such an application's build reported
   skipped by name — the catalog guards when `platform-artifacts` is touched and never a `*.pg.test.ts`; ESLint,
   errors only, on touched sources; and Prettier on every touched file. A failure fails
   the publication with the end of what it printed and nothing pushed: read it on the
   `check-commit` task, and commission the fix onto the branch. The pull request's CI
   remains the proof. By hand, from a checkout, it measures `HEAD` against `origin/main`.
4. **The operator merges.** A merge lands on the dev stack only when the stream that runs it
   merges `origin/main` into `live` (below).

Approvals are held until the verdict is in; an approval given early pushes a commit the
review may still send back.

## Sharing the machine

- **One stack.** The dev stack belongs to the stream that started it. No other stream runs
  `yarn start`, `yarn dev:*` or a host executor: two stacks on one Redis share consumer
  groups and run each other's work, and a second host executor takes the lane.
- **A merge into `live` restarts executors.** The host executor drains (Plan 315 D17): the
  stack's watcher sends it SIGUSR2, and it claims nothing new and restarts once its harness
  runs, checks and reviews have ended or their own timeouts have passed, so a merge waits
  for the steps in flight. It does not wait for a session between its turns: the restart
  discards every kept session's checkout, and with it whatever the coding agent left
  uncommitted, so a stream continuing a session (`continueFrom`) does not merge until that
  commission has published. Stopping the stack does not drain: SIGTERM
  and SIGINT end every harness run and discard every checkout at once, because whatever
  sends them kills soon after. So stop the stack only when no commission is in flight. A
  second SIGUSR2, or a SIGTERM during the drain, also ends everything at once. The other
  executors restart straight away, so merge only when no Helmsman turn is in flight. A stream that needs its branch
  on the stack asks the stream that runs it; that stream merges, runs `yarn db:migrate`
  when a migration arrived, rebuilds the `dist`s the web app reads, and updates the
  installed bundles through the Store when a catalog version moved.
- **Commissions can overlap**; each runs in its own detached checkout. The machine runs
  two coding agents at once unless `aflow harness concurrency <n>` says otherwise, and a
  review is a coding agent too; a commission or review past that waits for one to end,
  and its time counts from when it starts, so nothing needs holding back by hand.
- **Branch names carry the stream** (`aflow/320-…`, `aflow/publish-…`), and migration
  numbers are taken from `origin/main` at commission time, never from a branch.
- **CI minutes are billed.** Nothing is pushed to an open pull request outside the
  loop without the operator's word, and a fix to a pull request is one round appended
  onto its branch rather than a new pull request.

## Watching

- Session state: `docker exec phoenix-redis redis-cli HMGET
aflow:session:<tenant>:<sessionId>:state status waitingOnWorkflowRunId` — `PAUSED` with
  no run id is Helmsman free for the next message.
- Runs: `workflow_runs.run_id` (not `id`) in the tenant schema, and `workflow_run_tasks`
  by that `run_id`.
- A publication's `review-commit` task names the child run; `approve-push` skipped with the
  `anyOf` clause evaluated false is the autonomous push.

## What still binds (Plan 315 §6)

- **F57** — the MCP `start_session` call does not return for a conversation that pauses
  twice; the watch above is the way to read it.
- **F59** — a publication a newer one supersedes keeps its approval live; cancel it by
  hand before the next round, and say so in the brief.
- **F62** — a publication with no summary opens a pull request with an empty body; give a
  summary in the brief.
- **F65** — a publication appended onto a branch with a pull request pushes and then fails
  on the 422; the push is done and the failure is the step after it.
- **F66** — nothing merges `origin/main` into an appended branch; a branch `main` moved
  past meets its conflicts at GitHub and the merge is made by hand.
