# Executor Handler Pattern

Source of truth: `packages/executor-runtime/src/executor.ts`

## StepHandler interface

```typescript
interface StepHandler {
  stepType: string;

  // Lifecycle (optional)
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;

  // Validation (optional — runs before execute)
  validate?(ctx: ExecutorContext): Promise<AflowError | undefined>;

  // Main execution (required)
  execute(ctx: ExecutorContext): Promise<StepResult>;
}
```

## StepResult variants

```typescript
// Success
{ status: 'SUCCEEDED', outputRef: PayloadRef, costJson?: Record<string, unknown> }

// Failure
{ status: 'FAILED', error: AflowError }

// Paused (waiting for user input)
{ status: 'PAUSED', requestedInputRef: PayloadRef }
```

## ExecutorContext — what's available in execute()

```typescript
{
  // Identity
  job: StepJobMessage,
  tenantId: TenantId,
  runId: RunId,
  stepExecutionId: StepExecutionId,
  operationId: OperationId,
  attempt: number,

  // Payload I/O
  readPayload<T>(ref: PayloadRef): Promise<T>,
  writePayload(kind: PayloadKind, data: unknown): Promise<PayloadRef>,
  outputExists(): Promise<PayloadRef | null>,  // Idempotent short-circuit

  // Input resolution with schema validation
  resolveAndValidateInput<T>(template, schema): Promise<{ data: T, resolvedInputRef: PayloadRef }>,

  // Event emission
  emitRunEvent(evt): Promise<void>,

  // Utilities
  signal: AbortSignal,  // Timeout cancellation
  log: ExecutorLogger,
}
```

## Execution pipeline (what the runtime does)

1. Mark step STARTED
2. `handler.validate(ctx)` — optional pre-check
3. Check idempotent short-circuit: `ctx.outputExists()`
4. `handler.execute(ctx)` with timeout
5. Emit result (success/failure/paused) to results stream
6. Acknowledge Redis message

## Typical handler pattern

```typescript
const myHandler: StepHandler = {
  stepType: 'api',

  async execute(ctx) {
    // 1. Resolve and validate input
    const { data: input } = await ctx.resolveAndValidateInput(ctx.job.inputRef, MyInputSchema);

    // 2. Do the work
    const result = await doSomething(input, ctx.signal);

    // 3. Write output
    const outputRef = await ctx.writePayload('output', result);

    // 4. Return success
    return { status: 'SUCCEEDED', outputRef };
  },
};
```

## Error handling

- Throw errors with `.toAflowError()` method for structured errors
- Unknown errors auto-convert to `STEP_EXECUTION_ERROR`
- Error classification: `'user'` (caller's fault), `'internal'` (platform bug), `'transient'` (retry)
- Set `retryable: true` for transient errors

## Registering a handler

In the executor's `src/index.ts`:

```typescript
const runtime = new ExecutorRuntime(config, deps);
runtime.registerHandler(myHandler);
await runtime.start();
```
