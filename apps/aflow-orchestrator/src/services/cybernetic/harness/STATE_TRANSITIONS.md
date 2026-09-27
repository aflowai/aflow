# Workflow run state transitions (Plan 153 / 132v2)

Durable authority: `workflow_runs` + `workflow_run_tasks` rows (Postgres). Runner sessions are ephemeral workers; Helmsman sessions are waiters on `workflow_run_waiters`.

## Run-level (`workflow_runs.status`)

| From      | Event / handler                      | To          | Notes                                      |
| --------- | ------------------------------------ | ----------- | ------------------------------------------ |
| `running` | `completeRun(completed)`             | `completed` | CAS terminal                               |
| `running` | `completeRun(failed)`                | `failed`    | CAS terminal                               |
| `running` | `cancelRun`                          | `cancelled` | Cascade → bulk task cancel → `completeRun` |
| `running` | `ledgerPauseRun` / `pauseRunForTask` | `paused`    | Bumps `pause_version`                      |
| `paused`  | `resumeRun` (ledger)                 | `running`   | CAS on `pause_version`                     |
| terminal  | any forward path                     | terminal    | Idempotent no-op                           |

## Task-level (`workflow_run_tasks.status`)

| From        | Event / handler                       | To                   | Notes                                                                                                 |
| ----------- | ------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| (none)      | `reserveTaskSlots`                    | `scheduled`          | Slot reservation, run row held FOR UPDATE                                                             |
| `scheduled` | `claimAndSchedule` / `claimHumanTask` | `running` / `paused` | CAS upgrade of the reserved slot                                                                      |
| (none)      | `claimAndSchedule` / `claimHumanTask` | `running` / `paused` | Resume re-dispatch: `resume` deletes the paused row first, so the claim INSERTs without a reservation |
| `running`   | `onWorkflowTaskComplete` succeeded    | `succeeded`          | `casCompleteTask`                                                                                     |
| `running`   | `onWorkflowTaskComplete` failed       | `failed`             | May trigger `applyFailureMode`                                                                        |
| `running`   | `onWorkflowTaskComplete` paused       | `paused`             | Then `pauseRunForTask`                                                                                |
| `running`   | `cancelRun` cascade                   | `cancelled`          | Bulk CAS                                                                                              |
| `running`   | when-predicate false                  | `skipped`            | `recordTaskSkipped`                                                                                   |
| `paused`    | resume / handoff                      | `running`            | Human or `workflow.run.resume`                                                                        |
| terminal    | duplicate delivery                    | terminal             | Re-drive notify/dispatch only                                                                         |

## Forward-drive after task terminal

```
onWorkflowTaskComplete
  → recordTaskOutcome (CAS)
  → dispatchNextOrTerminate | applyFailureMode | pauseRunForTask
  → notifyWaiters (WHERE notified_at IS NULL)
```

## Stale / orphan recovery

`reconcileStaleRunForTenant` reads `workflow_run_completion_pending` + Redis session state → redrive `routeRunnerTerminalToHarness` or bump `due_at`.
