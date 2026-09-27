/**
 * Compute step operation schemas.
 *
 * Sandboxed code execution in ephemeral Docker containers.
 * Containers are isolated (no network, read-only root, non-root user, no capabilities).
 * Requires compute to be enabled in the space's compute policy.
 *
 * Output strategy (smart inline + PayloadRef):
 * - Small outputs (<=64KB) are returned inline — agent sees the full result directly.
 * - Large outputs get a truncated preview inline + full data in a PayloadRef.
 *   The agent can pass this ref to memory.store.put for cross-run persistence,
 *   or use it in a subsequent compute.sandbox.exec via the files input for chaining.
 */
import { z } from 'zod';

// ============================================================================
// compute.sandbox.exec - Execute Code in Sandbox
// ============================================================================

export const ComputeExecInputSchema = z
  .object({
    runtime: z
      .enum(['python3', 'python3-ml', 'nodejs', 'deno', 'bash'])
      .describe(
        'Language runtime. python3 = Python 3.12 stdlib only (lightweight). ' +
          'python3-ml = Python 3.12 with exactly these packages pre-installed: ' +
          'pandas, numpy, scikit-learn, xgboost, lightgbm, catboost, imbalanced-learn, scipy, matplotlib, optuna, torch (CPU-only, no GPU), ' +
          'jsonschema, requests, kaggle-environments (agent-vs-agent episode simulation; pure-Python/numpy envs such as kaggriculture, connectx, halite, rps work — envs needing jax, gfootball, open_spiel, or litellm fail to load). ' +
          'Nothing else is available in python3-ml — NO tensorflow, NO keras, ' +
          'and no pip install at runtime (the sandbox has no network); if a library is not in this list, do not plan around it. ' +
          'nodejs = Node.js 22, deno = Deno, bash = Alpine sh.',
      ),
    code: z
      .string()
      .max(1_000_000)
      .optional()
      .describe(
        'Inline source code. Use codePath instead for stored/published scripts. ' +
          'For multi-file projects, put the main script here and additional files in the files field.',
      ),
    codePath: z
      .string()
      .max(1024)
      .optional()
      .describe(
        'Memory path to a stored script (e.g. "/ml/pipeline.py"). ' +
          'Loaded before execution. Data files passed via files are at /tmp/input/. ' +
          'Use for iterative development and cross-run reuse.',
      ),
    entryPoint: z
      .string()
      .max(256)
      .optional()
      .describe(
        'Function name to call after loading the code (python3/nodejs only). ' +
          'If set, the code is loaded as a module and this function is invoked. ' +
          'For python3: calls the named function. For nodejs: calls module.exports[entryPoint]().',
      ),
    args: z
      .array(z.unknown())
      .max(100)
      .optional()
      .describe(
        'Arguments passed to the entry point function as positional args. ' +
          'Serialized as JSON and available via sys.argv (bash), process.argv (nodejs), or function params (with entryPoint).',
      ),
    env: z
      .record(z.string())
      .optional()
      .describe(
        'Environment variables injected into the container. Keys must be alphanumeric/underscore. ' +
          'Do NOT pass secrets — containers are ephemeral but env vars appear in logs.',
      ),
    inputPaths: z
      .array(z.string().max(1024))
      .max(20)
      .optional()
      .describe(
        'Memory paths to mount at /tmp/input/ before execution. ' +
          'Files are mounted preserving their full path structure: /tmp/input/<memoryPath>. ' +
          'Supports persistent paths (/data/train.csv → /tmp/input/data/train.csv) and ' +
          'virtual run output paths (/run/outputs/<toolCallId>/data → /tmp/input/run/outputs/<toolCallId>/data). ' +
          'Example: ["/data/train.csv", "/data/test.csv"] → open("/tmp/input/data/train.csv"). ' +
          'This is the simplest way to get data into compute.',
      ),
    inputMode: z
      .enum(['replace', 'append'])
      .default('replace')
      .optional()
      .describe(
        'How input files are handled in session mode. ' +
          'replace (default): clear /tmp/input/ before injecting new files — prevents stale data across turns. ' +
          'append: inject new files on top of existing ones — use when accumulating data across turns. ' +
          'Only relevant in session mode; ephemeral containers always start fresh.',
      ),
    files: z
      .record(
        z.string().max(10_000_000).describe('File content as a UTF-8 string (max 10MB per file)'),
      )
      .optional()
      .describe(
        'Additional files to mount at /tmp/input/, keyed by filename. ' +
          'Use for small inline content only. ' +
          'Read in code with open("/tmp/input/data.csv"). ' +
          'Inline: {"data.csv": "a,b\\n1,2"}. ' +
          'Prefer inputPaths for loading data from memory or run outputs — simpler and handles large data.',
      ),
    limits: z
      .object({
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(3600)
          .default(180)
          .describe(
            'Max wall-clock execution time in seconds (default 180, max 3600). Capped by space policy.',
          ),
        memoryMB: z
          .number()
          .int()
          .positive()
          .max(8192)
          .default(512)
          .describe('Max memory in MB (default 512, max 8192). Capped by space policy.'),
        cpuCores: z
          .number()
          .positive()
          .max(4)
          .default(1)
          .describe('CPU cores (default 1, max 4). Capped by space policy.'),
        maxOutputBytes: z
          .number()
          .int()
          .positive()
          .max(10_000_000)
          .default(1_000_000)
          .describe(
            'Max stdout+stderr captured (default 1MB). Output beyond this is discarded. ' +
              'For large results, write to /tmp/output/ and they will be returned as outputFiles.',
          ),
      })
      .optional()
      .describe(
        'Resource limits. All values are capped by the space compute policy ceiling. ' +
          'Defaults are conservative — increase for data-heavy workloads.',
      ),
    session: z
      .object({
        /** Enable persistent session for this run. Default: false (ephemeral). */
        enabled: z
          .boolean()
          .default(false)
          .describe(
            'Keep container alive across agent turns within this run. ' +
              'Python variables, DataFrames, and models persist in memory between turns. ' +
              'Files in /tmp/output/ persist. Use for any multi-turn workflow. ' +
              'This is purely a performance knob (warm container + Python globals); ' +
              'it does NOT gate the Memory-backed workspace — set the workspace field for that.',
          ),
        /** How long the container stays alive when idle (between agent turns). */
        idleTtlSeconds: z
          .number()
          .int()
          .positive()
          .max(7200)
          .default(1800)
          .describe(
            'Idle TTL in seconds (default 1800 = 30 min). Container is reaped after this idle period. Capped by space policy.',
          ),
        /** How long the cold file checkpoint persists after container is reaped. */
        checkpointTtlSeconds: z
          .number()
          .int()
          .positive()
          .max(259200)
          .default(86400)
          .describe(
            'Checkpoint TTL in seconds (default 86400 = 24h). Files restored on resume after container reap. Capped by space policy.',
          ),
      })
      .optional()
      .describe(
        'Session mode: keeps the container alive across agent turns within a run. ' +
          'Python variables, models, and files persist between turns. ' +
          'Use for iterative ML work, multi-step data analysis, or any workflow needing state across turns. ' +
          'Independent of workspace mode — workspace works for one-shot execs too.',
      ),
    workspace: z
      .object({
        inputs: z
          .array(z.string().max(1024))
          .max(50)
          .optional()
          .describe(
            'Memory paths or path-prefixes to hydrate into /workspace/ before the run. ' +
              'A trailing "/" means a prefix: ["/data/project/"] mounts every doc under it at ' +
              '/workspace/data/project/. Read them as plain files, e.g. ' +
              'pd.read_csv("/workspace/data/project/train.csv").',
          ),
        outputs: z
          .array(z.string().max(1024))
          .max(50)
          .optional()
          .describe(
            'Memory paths/dirs the run will WRITE. Their directories are created in /workspace/ ' +
              'up front (empty if Memory has nothing there yet — not a conflict), so code can write ' +
              'e.g. df.to_csv("/workspace/data/project/submission.csv"). Everything written under ' +
              '/workspace/ flushes back to Memory and is reported in workspaceFlush. A declared FILE ' +
              'output (no trailing "/") is a contract: a run that exits 0 must write it or the step ' +
              'fails (a crash/timeout instead returns normally with its exitCode + stderr, and ' +
              'workspaceFlush.missingOutputs lists what was not produced). Declare a file output only ' +
              'on the exec that produces it; for a write target you fill on a later sessioned turn, ' +
              'declare its directory (trailing "/"), which is not verified.',
          ),
        quotas: z
          .object({
            maxBytes: z
              .number()
              .int()
              .positive()
              .default(1_073_741_824)
              .describe('Workspace total cap in bytes (default 1 GiB). Capped by space policy.'),
            maxFileBytes: z
              .number()
              .int()
              .positive()
              .default(268_435_456)
              .describe('Per-file cap in bytes (default 256 MiB). Capped by space policy.'),
            maxFileCount: z
              .number()
              .int()
              .positive()
              .default(10_000)
              .describe('Max number of files in the workspace (default 10000).'),
          })
          .optional(),
      })
      .optional()
      .describe(
        'Memory-backed workspace — the canonical way to do file I/O with code. ' +
          'Presence enables it: Memory appears as a real filesystem at /workspace/. Declare ' +
          'inputs (paths/prefixes to read) and/or outputs (paths/dirs you will write); at least ' +
          'one is required. The platform hydrates inputs, creates the output dirs, runs your code, ' +
          'flushes every /workspace/ write back to Memory by reference (text or binary), and ' +
          'reports exactly what persisted in workspaceFlush (a conflicted/skipped write fails the ' +
          'step). For a one-shot exec the flush is at exec end (reported here); for a sessioned ' +
          'exec it is at teardown (not in this output). No inputPaths / /tmp/output / ' +
          'memory.store.put choreography — and mutually exclusive with that legacy escape hatch.',
      ),
    runtimePreset: z
      .enum(['quick', 'standard', 'ml-training'])
      .optional()
      .describe(
        'Semantic resource preset. quick: 60s/256MB (transforms, checks). ' +
          'standard: 3min/512MB (analysis, EDA). ml-training: 30min/4GB/2cpu (training, tuning). ' +
          'Explicit limits override preset values. Preset capped by space policy.',
      ),
    networkAccess: z
      .boolean()
      .default(false)
      .describe(
        'Enable network egress for this execution. Requires the space compute policy ' +
          'to have networkEgress.mode: "allowlist". Requested hosts must be in the ' +
          'space/tenant approved allowlist. Default: false (no network).',
      ),
    allowedHosts: z
      .array(z.string().max(256))
      .max(50)
      .optional()
      .describe(
        'Hosts this execution needs to reach (e.g., ["storage.googleapis.com"]). ' +
          'Must be a subset of the space compute policy allowedHosts. ' +
          'Only relevant when networkAccess is true.',
      ),
  })
  .refine((input) => input.code !== undefined || input.codePath !== undefined, {
    message: 'Either code or codePath must be provided',
    path: ['code'],
  })
  .refine((input) => !(input.code !== undefined && input.codePath !== undefined), {
    message: 'Provide either code or codePath, not both',
    path: ['codePath'],
  })
  .superRefine((input, ctx) => {
    if (input.workspace === undefined) return;

    const hasInputs = (input.workspace.inputs?.length ?? 0) > 0;
    const hasOutputs = (input.workspace.outputs?.length ?? 0) > 0;
    if (!hasInputs && !hasOutputs) {
      ctx.addIssue({
        code: 'custom',
        path: ['workspace'],
        message:
          'workspace requires file intent: declare inputs (paths/prefixes to read) and/or ' +
          'outputs (paths/dirs you will write), e.g. { inputs: ["/data/project/"] }.',
      });
    }
    if (input.inputPaths && input.inputPaths.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['inputPaths'],
        message:
          'MUTUALLY_EXCLUSIVE_FILE_HANDLING: inputPaths (legacy) cannot be used with workspace. ' +
          'Move those paths into workspace.inputs and read them from /workspace/<memoryPath>.',
      });
    }
    if (input.files && Object.keys(input.files).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message:
          'MUTUALLY_EXCLUSIVE_FILE_HANDLING: inline files (legacy) cannot be used with workspace. ' +
          'Write the file from your code into /workspace/ instead.',
      });
    }
  });
export type ComputeExecInput = z.infer<typeof ComputeExecInputSchema>;

export const ComputeExecOutputSchema = z.object({
  exitCode: z
    .number()
    .int()
    .describe('Process exit code. 0 = success, 124 = timeout, 127 = container launch failure.'),
  data: z
    .string()
    .describe(
      'Standard output (inline up to 64KB, preview when truncated). ' +
        'Full output accessible at /run/outputs/<toolCallId>/data.',
    ),
  stderr: z
    .string()
    .describe('Standard error (inline up to 64KB). Includes compiler/runtime errors and warnings.'),
  result: z
    .unknown()
    .optional()
    .describe(
      'Structured return value when using entryPoint — the JSON-serialized return value of the function.',
    ),
  outputFiles: z
    .record(z.string())
    .optional()
    .describe(
      'Files written to /tmp/output/ during execution, keyed by filename. ' +
        'Content is inline if small, or a PayloadRef if large. Use for generated CSVs, images, etc.',
    ),
  workspaceFlush: z
    .object({
      hydratedPaths: z
        .array(z.string())
        .describe(
          'Memory paths actually mounted into /workspace/ at hydrate time — resolved from inputs, ' +
            'plus any declared outputs that already existed in Memory (hydrated so an overwrite is a ' +
            'clean update). Shows exactly what was readable.',
        ),
      committed: z
        .array(
          z.object({
            path: z.string().describe('Memory path the workspace file was flushed to.'),
            version: z.number().int().nonnegative().describe('New Memory version after the flush.'),
            sizeBytes: z.number().int().nonnegative().describe('Size of the flushed content.'),
          }),
        )
        .describe('Files durably written back to Memory (by reference for large payloads).'),
      conflicts: z
        .array(
          z.object({
            path: z.string().describe('Memory path that conflicted (changed since hydrate).'),
            sidecarPath: z
              .string()
              .optional()
              .describe(
                'Where the local edit was rescued (a fresh Memory doc tagged "workspace_conflict"). ' +
                  'Absent only if the sidecar write itself failed.',
              ),
            currentVersion: z
              .number()
              .int()
              .nonnegative()
              .describe('The Memory version that won the conflict.'),
          }),
        )
        .describe(
          'Files NOT written because Memory moved on (or a doc already existed at an unhydrated path). ' +
            'The local content was rescued to a sidecar, never silently overwritten.',
        ),
      skipped: z
        .array(
          z.object({
            path: z.string().describe('Memory path that was skipped.'),
            reason: z
              .string()
              .describe('Why it was skipped (too_large, workspace_quota_exceeded, unreadable).'),
          }),
        )
        .describe(
          'Files dropped from the flush — either over a per-file/total cap (too_large, ' +
            "workspace_quota_exceeded) or could not be read (unreadable). See each entry's reason.",
        ),
      missingOutputs: z
        .array(z.string())
        .describe(
          'Declared FILE outputs (no trailing "/") the run did NOT produce. Non-empty = the step ' +
            'failed: a declared output contract was not met (e.g. submission.csv was never written).',
        ),
      bytesFlushed: z
        .number()
        .int()
        .nonnegative()
        .describe('Total bytes durably committed to Memory in this flush.'),
    })
    .optional()
    .describe(
      'Memory-backed workspace flush result. Present ONLY for a one-shot ' +
        '(ephemeral) workspace exec; a sessioned workspace flushes at teardown and is not reported here. ' +
        'The step is failed if a path the run wrote was skipped or conflicted, OR a declared file ' +
        'output was not produced — so "I saved my output" is never silently false.',
    ),
  durationMs: z
    .number()
    .int()
    .nonnegative()
    .describe('Wall-clock execution time in milliseconds (includes container startup).'),
  resourceUsage: z
    .object({
      peakMemoryMB: z.number().nonnegative().optional().describe('Peak memory usage in MB.'),
      cpuTimeMs: z.number().int().nonnegative().optional().describe('CPU time consumed in ms.'),
    })
    .optional()
    .describe('Resource usage statistics (when available from the container runtime).'),
  timedOut: z
    .boolean()
    .optional()
    .describe('True if execution was killed due to timeout. exitCode will be 124.'),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True if stdout or stderr exceeded 64KB and was truncated. ' +
        'Full output accessible at /run/outputs/<toolCallId>/data.',
    ),
  sessionInfo: z
    .object({
      sessionActive: z.boolean().describe('Whether the session container is still alive.'),
      sessionAge: z
        .number()
        .int()
        .nonnegative()
        .describe('Seconds since the session was first created.'),
      restoreSource: z
        .enum(['warm', 'checkpoint', 'fresh'])
        .describe(
          'How this execution was served. warm: existing container with full state. ' +
            'checkpoint: new container with files restored (Python vars lost). ' +
            'fresh: brand new container, no prior state.',
        ),
      persistedFiles: z
        .array(z.string())
        .optional()
        .describe('Files currently in /tmp/output/ from this and previous turns.'),
      remainingIdleTtlSeconds: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Seconds until the session is reaped if idle.'),
      workspace: z
        .object({
          hydratedPathsCount: z
            .number()
            .int()
            .nonnegative()
            .describe('Number of Memory documents hydrated into /workspace/ at session start.'),
          bytesUsed: z
            .number()
            .int()
            .nonnegative()
            .describe('Total bytes used by /workspace/ (manifest accounting, not host disk).'),
          dirtyPathsCount: z
            .number()
            .int()
            .nonnegative()
            .describe(
              'Number of paths that have been created or modified locally and not yet flushed to Memory.',
            ),
          pendingDeletesCount: z
            .number()
            .int()
            .nonnegative()
            .describe(
              'Number of paths the agent rm-ed in the workspace; deletions are NOT applied to Memory ' +
                'until an explicit compute.workspace.commit({ deletes: [...] }) op (Phase 2).',
            ),
          lastFlushedAt: z
            .string()
            .datetime()
            .nullable()
            .describe('ISO timestamp of the most recent flush, or null if never flushed.'),
        })
        .optional(),
    })
    .optional()
    .describe('Session state info. Only present when session mode is enabled.'),
  outputSummary: z
    .object({
      stdoutBytes: z
        .number()
        .int()
        .nonnegative()
        .describe('Total stdout size in bytes before truncation.'),
      stderrBytes: z
        .number()
        .int()
        .nonnegative()
        .describe('Total stderr size in bytes before truncation.'),
      stdoutLines: z.number().int().nonnegative().describe('Total number of lines in stdout.'),
      stderrLines: z.number().int().nonnegative().describe('Total number of lines in stderr.'),
      stdoutPreview: z
        .string()
        .optional()
        .describe(
          'First ~500 chars of stdout (only present when truncated, for quick inspection).',
        ),
      stderrPreview: z
        .string()
        .optional()
        .describe(
          'First ~500 chars of stderr (only present when truncated, for quick inspection).',
        ),
    })
    .optional()
    .describe(
      'Output size summary. Always present when truncated so agent can assess without loading full output.',
    ),
});
export type ComputeExecOutput = z.infer<typeof ComputeExecOutputSchema>;

// ============================================================================

import type { OperationRegistration } from '../catalog/operationCatalog.js';

export const ComputeOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'compute',
    group: 'sandbox',
    verb: 'exec',
    name: 'Execute Code',
    actionLabel: 'Running code…',
    semanticDescription:
      'Execute code in an isolated sandbox (Python 3.12, Node.js 22, Deno, or Bash). ' +
      'Containers are network-isolated and resource-limited. ' +
      'For file I/O over Memory data, use the workspace field — the canonical model: ' +
      'workspace: {inputs: ["/data/project/"], outputs: ["/data/project/submission.csv"]}. ' +
      'Memory mounts as a real filesystem at /workspace/; read /workspace/<path> and write ' +
      '/workspace/<path>, and writes flush back to Memory automatically (text or binary), ' +
      'reported in workspaceFlush. Works for one-shot AND sessioned execs (session: {enabled: true} ' +
      'is just a warm-container performance knob). ' +
      'Use for calculations, data transformations, ML training, or any task that benefits from running real code. ' +
      'Small outputs are returned inline; large outputs get a preview + PayloadRef. ' +
      'Supports codePath to load scripts from memory for iterative development (write → run → patch → re-run).',
    tags: ['compute', 'execution', 'sandbox', 'code', 'data'],
    outputSemanticType: 'compute_result',
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Run code in an isolated container. ' +
        'Runtimes: python3 (lightweight), python3-ml (pandas/sklearn/xgboost/lightgbm/catboost/optuna/torch-cpu pre-installed), nodejs, bash. ' +
        'For file I/O over Memory data use the workspace field (inputs to read, outputs to write) at /workspace/; ' +
        'add session: {enabled: true} to keep Python state warm across turns. ' +
        'Presets: quick (60s/256MB), standard (3min/512MB), ml-training (30min/4GB/2cpu).',
      whenToUse: [
        'Reading/writing data files from Memory (the canonical way) — workspace: {inputs: ["/data/<prefix>/"], outputs: ["/data/<prefix>/result.csv"]}. Read/write plain /workspace/<memoryPath>; writes flush back to Memory automatically (one-shot reports workspaceFlush; sessioned flushes at teardown). Add session: {enabled: true} for warm multi-turn ML.',
        'Calculations, math, statistics, or data analysis that must be exact (not approximated)',
        'Transforming, parsing, or converting data formats (CSV, JSON, XML, etc.)',
        'Validating data, schemas, or configurations programmatically',
        'Generating structured output (tables, reports) from raw data',
        'Iterative development — store script in memory (memory.store.put), execute via codePath, patch specific functions (memory.store.patch), re-run',
      ],
      whenNotToUse: [
        'Calling external APIs — prefer api.http.call (which can stream a Memory file as the body via bodySource.fromPath). Compute egress is the escape hatch for library-driven workflows.',
        'Persisting results across runs — just write to /workspace/<path> in workspace mode and it flushes automatically; for agent-authored documents (not sandbox data files) use memory.store.put.',
        'Simple text generation or reasoning — use ai.text.generate instead',
        'Running privileged or long-lived system processes',
      ],
      pitfalls: [
        'CANONICAL data-file model: declare workspace: {inputs: ["/data/project/"], outputs: ["/data/project/submission.csv"]}. Then read /workspace/data/project/train.csv and write /workspace/data/project/submission.csv. The platform hydrates inputs, creates the output dirs, and flushes every /workspace/ write back to Memory — reported in workspaceFlush. NO inputPaths / /tmp/output / memory.store.put choreography.',
        'workspace requires file intent: at least one of inputs or outputs. inputs are paths/prefixes to read; outputs are paths/dirs you will write (their dirs are pre-created even if empty in Memory). A trailing "/" is a prefix.',
        'Workspace flush uses compare-and-set on Memory version. If Memory was changed externally (or a doc already exists at a path you wrote but did not declare as an input), the local edit is rescued to <path>.conflict-<ISO> rather than silently lost — find rescued content via Query Memory tag "workspace_conflict". A conflicted/skipped write the run produced FAILS the step (check workspaceFlush).',
        'For iterative ML work (EDA → features → train → evaluate), add session: {enabled: true} so Python variables, DataFrames, and models persist between turns; the workspace files persist regardless.',
        'Use runtimePreset: "ml-training" for model training, cross-validation, or hyperparameter tuning (30min timeout, 4GB RAM, 2 CPUs).',
        'Long jobs (model training, cross-validation) should run as checkpointed units — per fold / per seed — persisting intermediate state under /workspace/ as each unit completes. The flush survives timeouts and kills, so a retry validates the checkpoints and skips completed units instead of restarting from scratch.',
        'python3-ml ships a FIXED package set (the runtime field lists it) — tensorflow/keras are NOT installed, torch is CPU-only (no GPU), and pip install cannot work (no network). Plan model code around scikit-learn/xgboost/lightgbm/catboost/torch-cpu.',
        'LEGACY escape hatch (avoid for skills; not the model): inputPaths: ["/data/train.csv"] mounts read-only at /tmp/input/ and /tmp/output/ comes back as outputFiles. Mutually exclusive with workspace. Prefer workspace for anything that reads/writes Memory data.',
        'Network is off by default. Set networkAccess: true and allowedHosts: ["host"] to enable egress to specific hosts. Requires space admin to enable allowlist mode in compute policy.',
      ],
      minimalExampleInput: {
        runtime: 'python3-ml' as const,
        code:
          'import pandas as pd\n' +
          'df = pd.read_csv("/workspace/data/project/train.csv")\n' +
          'print(df.describe().to_json())\n' +
          '# Write under /workspace/; it flushes to Memory at exec end (see workspaceFlush).\n' +
          'df.to_csv("/workspace/data/project/submission.csv", index=False)',
        workspace: {
          inputs: ['/data/project/'],
          outputs: ['/data/project/submission.csv'],
        },
      },
    },
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    inputZod: ComputeExecInputSchema,
    outputZod: ComputeExecOutputSchema,
  },
];
