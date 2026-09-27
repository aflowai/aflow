# Inline Operation Handlers

Inline operations are handled directly by the orchestrator without dispatching to an external executor. They run synchronously within the `SessionOrchestrator` process and emit synthetic step results back to the results stream.

## How routing works

`dispatchInlineOp()` in `SessionOrchestrator/index.ts` matches a step's `operationId` and calls the corresponding handler. Each handler:

1. Reads the resolved input from `PayloadStore`
2. Performs the operation (catalog query, DB mutation, etc.)
3. Emits a `StepResultMessage` via `addStepResult()` (SUCCESS or FAILED)

The orchestrator then processes the result like any other step completion.

## File layout

| File                   | Exports                                                            | Domain                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `types.ts`             | `InlineHandlerArgs`                                                | Shared interface for handlers using args-object pattern                                                                        |
| `getSchema.ts`         | `handleGetSchemaInline`                                            | `platform.catalog.get_schema` — query operation catalog                                                                        |
| `runStep.ts`           | `handleRunStepInline`                                              | `flow.control.run_step` — dynamically inject & schedule a step                                                                 |
| `endFlow.ts`           | `handleEndFlowInline`                                              | `flow.control.end` — terminate flow cleanly                                                                                    |
| `apiDiscovery.ts`      | `handleListApiDefinitionsInline`                                   | `platform.api.list_definitions` — list tenant API definitions                                                                  |
| `apiAdmin.ts`          | `handleApiAdminOpInline`                                           | `api.definition.*` / `api.binding.*` — API definition & binding CRUD                                                           |
| `flowCrud.ts`          | `handleFlowCrudInline`                                             | `flow.manage.*` — flow CRUD                                                                                                    |
| `spaceCrud.ts`         | `handleSpaceCrudInline`                                            | `platform.space.*` — space CRUD                                                                                                |
| `catalogExport.ts`     | `handleCatalogExportInline`                                        | `platform.catalog.export` — full catalog export                                                                                |
| `evalGoldenDataset.ts` | `handleEvalDataset{Get,List}Inline`, `handleEvalCasePromoteInline` | `eval.dataset.get/list`, `eval.case.promote` — golden-dataset reads + draft promotion (writes are operator-only server routes) |
| `guardrailCrud.ts`     | `handleGuardrailCrudInline`                                        | `guardrail.*` — guardrail policy and violation CRUD                                                                            |
| `index.ts`             | Barrel re-exports                                                  | All public exports from one import path                                                                                        |

## Handler contract

Handlers that use the positional-args signature (getSchema, runStep, endFlow, apiDiscovery):

```ts
(
  redis,
  payloadStore,
  context,
  stepDef,
  stepExecutionId,
  idempotencyKey,
  resolvedInputRef,
  attempt,
  scheduledAtMs,
  parentStepExecutionId?,
) => Promise<void>;
```

Handlers that use the `InlineHandlerArgs` object (apiAdmin, flowCrud, spaceCrud, catalogExport):

```ts
(args: InlineHandlerArgs) => Promise<void>;
```

Both patterns must:

- Call `addStepResult()` with either SUCCESS + `outputRef` or FAILED + `errorRef`
- Never throw — errors are caught internally and emitted as FAILED results

## Adding a new inline op

1. Create a new file in this directory (e.g., `myNewOp.ts`)
2. Implement the handler following the contract above
3. Re-export from `index.ts`
4. Add the routing case in `SessionOrchestrator/index.ts` → `dispatchInlineOp()`
