# Sandbox or tool: four frictions in the agent loop

A coding agent driving this repository runs inside a sandbox it does not choose: the
platform's posture decides what it may write, open and listen on. When a command fails
there, the failure belongs to one of two owners, and only one of them is this
repository's to change.

**The rule.** A friction belongs to the **posture** when what the sandbox refuses is the
thing being exercised. A test of a listener needs a listener, and only another posture
can give it one. There the tool's job is to say so: skip with a name for the refusal, and
let CI, which has the listener, run it. A friction belongs to the **tool** when the tool
asks for something its job does not need, such as a temporary file to count lines or a
socket to run a script in-process. It also does when the tool refuses a configuration
that is valid. Then the tool changes, and the posture stays as it is.

The posture itself is the platform's and is not changed here.

| #   | Friction                                                                                        | Owner                                  | Remedy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Under the `open` posture, host-executor tests meet `listen EPERM` on 127.0.0.1 and Unix sockets | **Posture** (tool-side follow-through) | The tests exist to exercise real listeners: the confined runner's proxies, the egress proxy, and the self-test's own loopback listener. The posture refuses every listener, so they cannot run there. Each one probes the real call (`__tests__/fixtures/capabilities.ts`) and skips with the refusal in its name, or carries the `listener` tag that the check leaves out on macOS and names (`scripts/listener-tests.mjs`). CI runs them all. The two open-posture self-test tests had neither, so they failed rather than skipped; they now require `LOOPBACK_LISTENER`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| b   | `yarn format` cannot `mktemp`                                                                   | **Tool**                               | `scripts/format.sh` kept the rewritten paths in a temporary file only to count them. It now counts them as they stream past, in a shell loop writing through a duplicated descriptor. It never opens `/dev/fd/N`, which the same sandbox also refuses. Output and exit status are unchanged: a failing Prettier fails the script with no count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| c   | The large-files and context-budget CLIs need `node --import tsx` on Node 22.16                  | **Tool**                               | tsx's command line starts the script as a child and opens an IPC socket to it, which is the same refused `listen`. Its loader runs the script in-process and opens none. `scripts/verify-commit.mjs` already ran both guards that way. `yarn typecheck`, `yarn large-files:*` and `yarn context:*` now do too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| d   | The local-shepherd Store bundle writes no agent when the space has two pushing folders          | **Tool**                               | Nothing in the sandbox is involved. The install refused a valid space because it would not guess which folder was meant. It no longer guesses: the agent, still under the skill's slug, gets one `workflow.run.start` step per folder with a publish prefix. Each start's input is its config alone (the step field `inputPassthrough: false`). Otherwise a start is handed the run's input or the previous start's output, and the strict `workflow.run.start` input refuses those keys. Every start runs whatever an earlier one did, so one folder's refusal stops no other folder's pass. The first failure moves the run onto a second path with the remaining starts, which ends on `workflow.run.fail`. The run therefore fails exactly when any start failed, not according to which start came last. One schedule then tends every folder. The bundle moves to revision 2, so a space already holding it is offered the update, and the update is what writes the agent. |

## Tests

- **a**: `apps/aflow-executor-host/src/__tests__/sandboxPosture.test.ts`. Under a sandbox
  that refuses a loopback listener, the boot self-test's two tests skip and name the
  refusal; elsewhere they run as before.
- **b**: `scripts/format.test.mjs`. Runs the script against a stub Prettier with
  `TMPDIR` naming no directory. Checks the paths on stdout, the count on stderr, and a
  failure that claims no count. Also checks that no command line opens a temporary file
  or a descriptor by path.
- **c**: `scripts/guard-cli-invocation.test.mjs`. Every root script that names either
  guard runs it as `node --import tsx <guard>`.
- **d**: `packages/cybernetic-runtime/src/stagedChange/applyBundledAgents.test.ts` covers
  one folder, two folders, none, and a slug already taken.
  `packages/platform-artifacts/src/skillCatalog/localPrShepherd.test.ts` checks that the
  two- and three-folder definitions parse and validate. It also walks the graph for every
  combination of refused folders, checking that each folder is started once and that the
  run fails exactly when a start did, and that a starter with no runs is refused.
  `apps/aflow-orchestrator/src/services/SessionOrchestrator/helpers/stepInputResolution.test.ts`
  resolves every step of those definitions against the run input, a previous start's
  output and a failure summary. Each start must validate with only its folder's input. As a
  control, the same start with passthrough left on must be refused.

## What this leaves

- **(d) Folders added later.** An agent's folders are the ones connected when it was
  written. Like every bundled agent already in a space, it is the space's, and an update
  does not rewrite it. A folder connected afterwards is started with its own `bindingId`,
  as the bundle's description says.
- **Seen but not among the four.** Three host-executor tests about replace refs
  (`worktree.test.ts`, `commitScan.test.ts`, `harnessGitEnvironment.test.ts`) fail when the
  calling environment exports `GIT_NO_REPLACE_OBJECTS=1`. The agent sandbox exports it,
  and they pass without it. The tests inherit the ambient git environment for the control
  they compare against. That makes it a tool-side friction too, and its own slice.
