import type { OperationRegistration } from '../../catalog/operationCatalog.js';
import type {
  WorkflowPutInputSchema as WorkflowPutInputSchemaT,
  WorkflowPutOutputSchema as WorkflowPutOutputSchemaT,
  WorkflowPatchInputSchema as WorkflowPatchInputSchemaT,
  WorkflowPatchOutputSchema as WorkflowPatchOutputSchemaT,
  WorkflowGetInputSchema as WorkflowGetInputSchemaT,
  WorkflowGetOutputSchema as WorkflowGetOutputSchemaT,
  WorkflowListInputSchema as WorkflowListInputSchemaT,
  WorkflowListOutputSchema as WorkflowListOutputSchemaT,
} from './manage.js';
import type {
  WorkflowRunStartInputSchema as WorkflowRunStartInputSchemaT,
  WorkflowRunStartOutputSchema as WorkflowRunStartOutputSchemaT,
} from './runStart.js';
import type {
  WorkflowRunResumeInputSchema as WorkflowRunResumeInputSchemaT,
  WorkflowRunResumeOutputSchema as WorkflowRunResumeOutputSchemaT,
} from './runResume.js';
import type {
  WorkflowRunCancelInputSchema as WorkflowRunCancelInputSchemaT,
  WorkflowRunCancelOutputSchema as WorkflowRunCancelOutputSchemaT,
} from './runCancelOp.js';
import type {
  WorkflowRunDetailInputSchema as WorkflowRunDetailInputSchemaT,
  WorkflowRunDetailOutputSchema as WorkflowRunDetailOutputSchemaT,
} from './runDetail.js';
import type {
  WorkflowRunListAttentionInputSchema as WorkflowRunListAttentionInputSchemaT,
  WorkflowRunListAttentionOutputSchema as WorkflowRunListAttentionOutputSchemaT,
} from './runAttention.js';
import type {
  WorkflowEvaluateInputSchema as WorkflowEvaluateInputSchemaT,
  WorkflowEvaluateOutputSchema as WorkflowEvaluateOutputSchemaT,
} from './evaluate.js';
import type {
  WorkflowLearnInputSchema as WorkflowLearnInputSchemaT,
  WorkflowLearnOutputSchema as WorkflowLearnOutputSchemaT,
} from './learnOp.js';
import type {
  WorkflowLedgerGetInputSchema as WorkflowLedgerGetInputSchemaT,
  WorkflowLedgerGetOutputSchema as WorkflowLedgerGetOutputSchemaT,
} from './ledgerGet.js';
import type {
  WorkflowCampaignStartInputSchema as WorkflowCampaignStartInputSchemaT,
  WorkflowCampaignStartOutputSchema as WorkflowCampaignStartOutputSchemaT,
  WorkflowCampaignGetInputSchema as WorkflowCampaignGetInputSchemaT,
  WorkflowCampaignGetOutputSchema as WorkflowCampaignGetOutputSchemaT,
  WorkflowCampaignListInputSchema as WorkflowCampaignListInputSchemaT,
  WorkflowCampaignListOutputSchema as WorkflowCampaignListOutputSchemaT,
  WorkflowCampaignUpdateInputSchema as WorkflowCampaignUpdateInputSchemaT,
  WorkflowCampaignUpdateOutputSchema as WorkflowCampaignUpdateOutputSchemaT,
  WorkflowCampaignEndInputSchema as WorkflowCampaignEndInputSchemaT,
  WorkflowCampaignEndOutputSchema as WorkflowCampaignEndOutputSchemaT,
  WorkflowCampaignRefreshInputSchema as WorkflowCampaignRefreshInputSchemaT,
  WorkflowCampaignRefreshOutputSchema as WorkflowCampaignRefreshOutputSchemaT,
} from './campaignOps.js';

interface WorkflowRegistrationSchemas {
  WorkflowPutInputSchema: typeof WorkflowPutInputSchemaT;
  WorkflowPutOutputSchema: typeof WorkflowPutOutputSchemaT;
  WorkflowPatchInputSchema: typeof WorkflowPatchInputSchemaT;
  WorkflowPatchOutputSchema: typeof WorkflowPatchOutputSchemaT;
  WorkflowGetInputSchema: typeof WorkflowGetInputSchemaT;
  WorkflowGetOutputSchema: typeof WorkflowGetOutputSchemaT;
  WorkflowListInputSchema: typeof WorkflowListInputSchemaT;
  WorkflowListOutputSchema: typeof WorkflowListOutputSchemaT;
  WorkflowRunStartInputSchema: typeof WorkflowRunStartInputSchemaT;
  WorkflowRunStartOutputSchema: typeof WorkflowRunStartOutputSchemaT;
  WorkflowRunResumeInputSchema: typeof WorkflowRunResumeInputSchemaT;
  WorkflowRunResumeOutputSchema: typeof WorkflowRunResumeOutputSchemaT;
  WorkflowRunCancelInputSchema: typeof WorkflowRunCancelInputSchemaT;
  WorkflowRunCancelOutputSchema: typeof WorkflowRunCancelOutputSchemaT;
  WorkflowRunDetailInputSchema: typeof WorkflowRunDetailInputSchemaT;
  WorkflowRunDetailOutputSchema: typeof WorkflowRunDetailOutputSchemaT;
  WorkflowRunListAttentionInputSchema: typeof WorkflowRunListAttentionInputSchemaT;
  WorkflowRunListAttentionOutputSchema: typeof WorkflowRunListAttentionOutputSchemaT;
  WorkflowEvaluateInputSchema: typeof WorkflowEvaluateInputSchemaT;
  WorkflowEvaluateOutputSchema: typeof WorkflowEvaluateOutputSchemaT;
  WorkflowLearnInputSchema: typeof WorkflowLearnInputSchemaT;
  WorkflowLearnOutputSchema: typeof WorkflowLearnOutputSchemaT;
  WorkflowLedgerGetInputSchema: typeof WorkflowLedgerGetInputSchemaT;
  WorkflowLedgerGetOutputSchema: typeof WorkflowLedgerGetOutputSchemaT;
  WorkflowCampaignStartInputSchema: typeof WorkflowCampaignStartInputSchemaT;
  WorkflowCampaignStartOutputSchema: typeof WorkflowCampaignStartOutputSchemaT;
  WorkflowCampaignGetInputSchema: typeof WorkflowCampaignGetInputSchemaT;
  WorkflowCampaignGetOutputSchema: typeof WorkflowCampaignGetOutputSchemaT;
  WorkflowCampaignListInputSchema: typeof WorkflowCampaignListInputSchemaT;
  WorkflowCampaignListOutputSchema: typeof WorkflowCampaignListOutputSchemaT;
  WorkflowCampaignUpdateInputSchema: typeof WorkflowCampaignUpdateInputSchemaT;
  WorkflowCampaignUpdateOutputSchema: typeof WorkflowCampaignUpdateOutputSchemaT;
  WorkflowCampaignEndInputSchema: typeof WorkflowCampaignEndInputSchemaT;
  WorkflowCampaignEndOutputSchema: typeof WorkflowCampaignEndOutputSchemaT;
  WorkflowCampaignRefreshInputSchema: typeof WorkflowCampaignRefreshInputSchemaT;
  WorkflowCampaignRefreshOutputSchema: typeof WorkflowCampaignRefreshOutputSchemaT;
}

export function createWorkflowOperationRegistrations(
  schemas: WorkflowRegistrationSchemas,
): OperationRegistration[] {
  const {
    WorkflowPutInputSchema,
    WorkflowPutOutputSchema,
    WorkflowPatchInputSchema,
    WorkflowPatchOutputSchema,
    WorkflowGetInputSchema,
    WorkflowGetOutputSchema,
    WorkflowListInputSchema,
    WorkflowListOutputSchema,
    WorkflowRunStartInputSchema,
    WorkflowRunStartOutputSchema,
    WorkflowRunResumeInputSchema,
    WorkflowRunResumeOutputSchema,
    WorkflowRunCancelInputSchema,
    WorkflowRunCancelOutputSchema,
    WorkflowRunDetailInputSchema,
    WorkflowRunDetailOutputSchema,
    WorkflowRunListAttentionInputSchema,
    WorkflowRunListAttentionOutputSchema,
    WorkflowEvaluateInputSchema,
    WorkflowEvaluateOutputSchema,
    WorkflowLearnInputSchema,
    WorkflowLearnOutputSchema,
    WorkflowLedgerGetInputSchema,
    WorkflowLedgerGetOutputSchema,
    WorkflowCampaignStartInputSchema,
    WorkflowCampaignStartOutputSchema,
    WorkflowCampaignGetInputSchema,
    WorkflowCampaignGetOutputSchema,
    WorkflowCampaignListInputSchema,
    WorkflowCampaignListOutputSchema,
    WorkflowCampaignUpdateInputSchema,
    WorkflowCampaignUpdateOutputSchema,
    WorkflowCampaignEndInputSchema,
    WorkflowCampaignEndOutputSchema,
    WorkflowCampaignRefreshInputSchema,
    WorkflowCampaignRefreshOutputSchema,
  } = schemas;

  return [
    // --- workflow.manage.* ---
    {
      stepType: 'workflow',
      group: 'manage',
      verb: 'put',
      name: 'Create Workflow',
      actionLabel: 'Creating workflow\u2026',
      semanticDescription:
        'Create a workflow as a draft. It runs once the operator approves it; changes to an existing workflow go through workflow.manage.patch. ' +
        'A workflow is a complete unit combining outcomes, tasks, iteration policy, and learnings. ' +
        'Workflows support three modes: optimization (same tasks, improve via learnings), ' +
        'process (different input each run), and project (one-shot).',
      tags: ['workflow', 'manage'],
      groupDisplayName: 'Workflow Management',
      groupDescription:
        'Create, read, update, and list workflows — structured iterative work units with outcomes, tasks, and learnings.',
      idempotency: 'non_idempotent',
      mutates: true,
      usage: {
        oneLine: 'Create a workflow as a draft for the operator to approve.',
        whenToUse: [
          'Setting up an optimization loop (ML tuning, prompt engineering)',
          'Defining a recurring process with quality outcomes',
          'Planning a complex multi-step project',
        ],
        whenNotToUse: [
          'Simple one-off task — just run a flow directly',
          'Changing a workflow that already exists — use workflow.manage.patch; a definition change becomes a proposal',
        ],
        pitfalls: [
          'Slug must be URL-safe lowercase (a-z, 0-9, hyphens)',
          'Each task needs either an agent or an operation to execute',
          'Fails if the slug already exists — there is no replace',
          'The workflow is created as a draft; the operator approves it, and it cannot run until then',
        ],
        minimalExampleInput: {
          slug: 'lead-scoring-optimizer',
          name: 'Lead Scoring Optimizer',
          outcomes: [
            {
              id: 'target-f1',
              name: 'Target F1 Score',
              evaluator: { type: 'threshold', metric: 'f1_score', operator: 'gt', target: 0.85 },
            },
          ],
          mode: 'optimization',
          tasks: [
            {
              taskId: 'prepare-data',
              name: 'Prepare Data',
              goal: 'Clean and prepare the labeled examples',
              type: 'agent',
            },
            {
              taskId: 'train-model',
              name: 'Train Model',
              goal: 'Train and evaluate the scoring model',
              type: 'agent',
              dependsOn: ['prepare-data'],
            },
            {
              taskId: 'record-results',
              name: 'Record Results',
              goal: 'Store metrics and recommendations for the next run',
              type: 'agent',
              dependsOn: ['train-model'],
            },
          ],
        },
      },
      accessMode: 'write',
      inputZod: WorkflowPutInputSchema,
      outputZod: WorkflowPutOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'manage',
      verb: 'patch',
      name: 'Patch Workflow',
      actionLabel: 'Patching skill\u2026',
      semanticDescription:
        'Apply a targeted change to an existing skill via RFC 6902 JSON Patch. ' +
        'Use for bumping the run budget, retiring a skill (status completed or abandoned), renaming, ' +
        'tweaking a single task, or changing the skill goal / campaign contract via ' +
        '`/goal` and `/campaign/fields/{key}` paths. Definition-touching patches (tasks, ' +
        'outcomes, goal, campaign) are staged as a workflow_refinement proposal for operator ' +
        'review; metadata patches (budget, name, a status other than approved) apply directly. ' +
        'Approving a skill is the operator\u2019s, never a patch.',
      tags: ['workflow', 'manage', 'patch'],
      idempotency: 'non_idempotent',
      mutates: true,
      usage: {
        oneLine: 'Patch a skill with RFC 6902 ops (budget, status, task, goal, campaign field).',
        whenToUse: [
          'Bumping budget.maxRuns when the agent hits the cap mid-optimization',
          'Renaming or retuning a single task without touching the rest',
          'Changing the skill goal (replace /goal) or a campaign field (/campaign/fields/{key})',
        ],
        whenNotToUse: [
          'Initial creation — use workflow.manage.put',
          'Approving a skill — the operator approves it from the skill page',
        ],
        pitfalls: [
          'Patch paths must start with "/" (e.g., "/budget/maxRuns"); a task may be addressed as /tasks/{taskId} or /tasks/{index} — a segment of digits is always an index',
          'Use expectedRevision to guard against concurrent writers',
          'A single patch may not mix metadata (budget/status) with definition (tasks/goal/campaign)',
          'Identity campaign fields are immutable — their schema cannot be reshaped, only relabeled',
          'Operations that run only as workflow steps, such as ai.decision.decide, are found with catalog.tool.search workflowSteps: true; a when that reads tasks.<id>.output.<path> is refused when the producer does not emit that path',
        ],
        minimalExampleInput: {
          slug: 'lead-scoring-optimizer',
          operations: [{ op: 'replace', path: '/budget/maxRuns', value: 30 }],
        },
      },
      accessMode: 'write',
      inputZod: WorkflowPatchInputSchema,
      outputZod: WorkflowPatchOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'manage',
      verb: 'get',
      name: 'Get Workflow',
      actionLabel: 'Loading workflow\u2026',
      semanticDescription:
        'Get a workflow by slug — the one-stop read for status, run budget, and ledger. ' +
        'Returns the workflow definition plus a ledger summary with totalRuns, lastRunStatus, ' +
        'bestScore, a compact per-run trajectory (the git-log view: runId, status, timing, ' +
        'learningCount, costCents, score), active learnings, and a budget block. The heavy ' +
        'recentEntries (full taskResults + evaluation + learnings per run) are opt-in via ' +
        'includeRecentEntries; page back through older runs with the before / nextCursor cursor. ' +
        'Use this before deciding whether to start another run or adjust config via ' +
        'workflow.manage.patch.',
      tags: ['workflow', 'read'],
      outputSemanticType: 'workflow_overview',
      idempotency: 'idempotent',
      mutates: false,
      usage: {
        oneLine:
          'Retrieve a workflow with a compact run trajectory, budget, and learnings in one call.',
        whenToUse: [
          'Understanding the current state of a workflow before running it',
          'Checking how many runs remain against the budget',
          'Reviewing accumulated learnings and the last run status',
          'Scanning the run history (trajectory); page older runs with before=nextCursor',
        ],
        whenNotToUse: ['Listing all workflows — use workflow.manage.list'],
        pitfalls: [
          'The default response is compact: recentEntries is empty unless includeRecentEntries=true. For one run’s full detail prefer workflow.run.detail({ runId }).',
          'Page back with before = the previous response’s ledgerSummary.nextCursor (pass it verbatim — it is an opaque cursor, not a timestamp).',
        ],
        minimalExampleInput: { slug: 'lead-scoring-optimizer' },
      },
      accessMode: 'read',
      inputZod: WorkflowGetInputSchema,
      outputZod: WorkflowGetOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'manage',
      verb: 'list',
      name: 'List Workflows',
      actionLabel: 'Listing workflows\u2026',
      semanticDescription:
        'List workflows in the workspace, optionally filtered by status or mode. ' +
        'Returns summary info including run counts and best scores.',
      tags: ['workflow', 'list'],
      idempotency: 'idempotent',
      mutates: false,
      usage: {
        oneLine: 'List workflows in the workspace with status and progress.',
        whenToUse: [
          'Discovering what workflows exist in the workspace',
          'Checking which workflows are active, completed, or abandoned',
        ],
        whenNotToUse: ['Need detailed info — use workflow.manage.get'],
        pitfalls: [],
        minimalExampleInput: {},
      },
      accessMode: 'read',
      inputZod: WorkflowListInputSchema,
      outputZod: WorkflowListOutputSchema,
    },

    // --- workflow.run.* ---
    {
      stepType: 'workflow',
      group: 'run',
      verb: 'start',
      name: 'Start Workflow Run',
      actionLabel: 'Starting workflow run\u2026',
      semanticDescription:
        'Start a new run of a workflow. The harness owns task dispatch — agent and ' +
        'operation tasks are scheduled, executed, and finalized by the workflow run ' +
        'harness, not by the calling agent. The caller parks until the run terminates ' +
        '(or pauses for input). The terminal tool result carries a structured `result` ' +
        'block — promoted output values (`result.output`, headline key in ' +
        '`result.primaryOutput`), the goal-metric score with target check ' +
        '(`result.score`), deterministic outcome checks, the closing task summary, a ' +
        'pointer to any rendered UI artifact, and the skill\u2019s `result.guidance` for ' +
        'what to do next — so a follow-up workflow.run.detail is usually unnecessary. ' +
        'The workflow must be "approved".',
      tags: ['workflow', 'run', 'execute'],
      outputSemanticType: 'workflow_run_status',
      groupDisplayName: 'Workflow Execution',
      groupDescription: 'Start, resume, evaluate, and learn from workflow runs.',
      idempotency: 'non_idempotent',
      mutates: true,
      usage: {
        oneLine: 'Start a workflow run — the harness owns task dispatch and lifecycle.',
        whenToUse: [
          'Beginning the next optimization iteration',
          'Starting a process run with new input',
          'Launching a project workflow',
        ],
        whenNotToUse: ['Workflow is still in draft — approve it first via workflow.manage.patch'],
        pitfalls: [
          'Workflow must be in "approved" status',
          'Returns when the run terminates or pauses; the calling agent does not invoke per-task tools.',
          'Read the terminal `result` block first (output values, score vs target, summary, guidance) — ' +
            'only call workflow.run.detail when you need per-task forensics beyond it.',
          'When the skill declares run inputs (its SpaceContext entry carries `firstTaskInputContract`, ' +
            'or workflow.manage.get returns one), pass their values as structured `inputs` keyed by the ' +
            'same field names — NOT as free-form `instructions`. A missing required input is rejected at ' +
            'start (PARENT_INPUTS_INVALID) naming the field; putting it in `instructions` still fails.',
        ],
        minimalExampleInput: { slug: 'lead-scoring-optimizer' },
      },
      accessMode: 'write',
      inputZod: WorkflowRunStartInputSchema,
      outputZod: WorkflowRunStartOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'run',
      verb: 'resume',
      name: 'Resume Workflow Run',
      actionLabel: 'Resuming workflow run\u2026',
      semanticDescription:
        'Resume a paused workflow run. Always start from the `suggestedResumeCall` ' +
        'embedded in the pause contract — it carries the correct `pauseVersion` and ' +
        'pre-selects the right `resolution.mode` for the pause cause. Only add ' +
        'free-text fields (`instructions`, `remediationConfirmed`, `reason`) on top; ' +
        'never reconstruct the call from scratch. `resolution.mode` must be one of ' +
        'the `allowedResumeModes` listed in the contract — attempting an unlisted mode ' +
        'is rejected immediately.',
      tags: ['workflow', 'run', 'resume'],
      // The seven-branch union was 1,578 chars of the emitted schema and carried
      // no descriptions — every branch repeated the same discriminator wrapper.
      // `mode` stays a real enum, because that is the part that constrains
      // generation; the per-mode payload moves into prose. The authoritative
      // shape for a given pause is `pause.pausedTaskInputContract`, delivered
      // with the envelope at the point of use, and the description above already
      // tells the agent to start from `suggestedResumeCall` rather than compose
      // this by hand.
      agentCollapsedFields: {
        resolution: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: [
                'replace_output',
                're_execute',
                'acknowledge',
                'provide_input',
                'fail',
                'reject',
                'retry_failed_task',
              ],
            },
          },
          required: ['mode'],
          description:
            'Copy from `pause.suggestedResumeCall.args.resolution`. Payload by mode — ' +
            'replace_output: output (any, required); ' +
            're_execute: instructions?, correctedInput?, remediationConfirmed? (boolean); ' +
            'acknowledge: no payload; ' +
            'provide_input: taskId (string, required), inputs (object keyed by bindAs, required); ' +
            'fail: reason (string, required); ' +
            'reject: comment? (string); ' +
            'retry_failed_task: taskId (string), failedAt (ISO date-time), attempt (positive int) — all required, all copied verbatim from the failed task row — plus remediationNote? (string).',
        },
      },
      outputSemanticType: 'workflow_run_status',
      idempotency: 'non_idempotent',
      mutates: true,
      usage: {
        oneLine: 'Resume a paused workflow run — copy suggestedResumeCall, add free-text, call.',
        whenToUse: [
          'Operator supplied missing input / confirmed side-effect remediation (`re_execute`)',
          'Data was unavailable and has now been populated — retry the paused task (`re_execute`)',
          'Accepting / acknowledging a paused notification (`acknowledge`)',
          'Providing required input to an input-gated task (`provide_input`)',
          "Patching a task's output when re-execution isn't possible (`replace_output`)",
          'Marking a paused task as failed / rejecting an approval (`fail`)',
        ],
        whenNotToUse: [
          'Starting a fresh run — use workflow.run.start',
          'Retrying a FAILED (terminal) run — use resolution.mode `retry_failed_task` instead',
        ],
        pitfalls: [
          'Always use `suggestedResumeCall` from the surfaced pause contract as your template — ' +
            'it pre-fills `pauseVersion` and selects the right mode. Never construct the call ' +
            'from scratch; `pauseVersion` is a stale-snapshot guard that must match the live ' +
            'run row or the call is rejected with STALE_PAUSE_VERSION.',
          '`resolution.mode` must be one of `allowedResumeModes` from the contract. If only ' +
            "`fail` is advertised, the task's retry budget is exhausted (attempt >= maxAttempts). " +
            'To enable `re_execute`, the skill author must raise `maxAttempts` on the task definition.',
          '`re_execute` requires `remediationConfirmed: true` in the resolution when ' +
            '`retryability` is `unknown` or `unsafe` — the suggested call deliberately omits it ' +
            'so you must explicitly assert that any prior side-effects have been remediated.',
          'Use mode `fail` to mark a paused task as failed (e.g., operator rejected an approval). ' +
            'The harness routes through applyFailureMode — descendant tasks are blocked per the ' +
            "human task's failureMode: 'isolate' | 'cancel_siblings'.",
          'Resolving a pause does NOT displace sessions already waiting on the run — pass ' +
            '`takeOver: true` only when you intend to take over driving it; released waiters ' +
            'wake with outcome `handed_off` and stop observing the run. `takeOver` applies ' +
            'only to paused-run resolution, not retry_failed_task or stalled-run recovery.',
        ],
        minimalExampleInput: {
          runId: '00000000-0000-0000-0000-000000000000',
          pauseVersion: 1,
          resolution: { mode: 'acknowledge' },
        },
      },
      accessMode: 'write',
      inputZod: WorkflowRunResumeInputSchema,
      outputZod: WorkflowRunResumeOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'run',
      verb: 'cancel',
      name: 'Cancel Workflow Run',
      actionLabel: 'Cancelling workflow run…',
      semanticDescription:
        'Cancel an in-flight or paused workflow run. Interrupts every Runner session bound to a ' +
        'non-terminal task, marks remaining task rows cancelled (preserving completed tasks as ' +
        'evidence), wakes any Helmsman parked on the run with outcome="cancelled", and writes an ' +
        'attention item. The harness owns terminal transitions; cancel is the only agent-callable terminal op.',
      tags: ['workflow', 'run', 'cancel'],
      outputSemanticType: 'workflow_run_status',
      idempotency: 'non_idempotent',
      mutates: true,
      usage: {
        oneLine: 'Cancel a running or paused workflow run.',
        whenToUse: [
          'User wants to stop a stuck or unwanted run',
          'A run is blocked on input that will not arrive',
          'Replacing an in-flight run with a fresh start',
        ],
        whenNotToUse: ['The run is already terminal (completed/failed/cancelled)'],
        pitfalls: [
          'Completed task rows are preserved — only non-terminal rows transition to cancelled.',
        ],
        minimalExampleInput: { runId: '00000000-0000-0000-0000-000000000000' },
      },
      accessMode: 'write',
      inputZod: WorkflowRunCancelInputSchema,
      outputZod: WorkflowRunCancelOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'run',
      verb: 'detail',
      name: 'Workflow Run Detail',
      actionLabel: 'Loading workflow run detail…',
      semanticDescription:
        'Read the current state of a workflow run. Returns the run row, all task rows, the active ' +
        'waiter set, and (if paused) the live resume contract with a freshly-injected pauseVersion. ' +
        'Pure read, cross-session: any Helmsman in the run’s space can call to pick up an ' +
        'in-flight or paused run. Pass `present: true` to ALSO show the user a live run card inline ' +
        'in chat (without starting or resuming anything) — you still receive the run data.',
      tags: ['workflow', 'run', 'detail', 'observe'],
      outputSemanticType: 'workflow_run_status',
      idempotency: 'idempotent',
      mutates: false,
      usage: {
        oneLine: 'Load the live state of a workflow run, including the resume contract if paused.',
        whenToUse: [
          'Picking up a paused run started by another session',
          'Inspecting progress / which tasks are running',
          'Checking the live pauseVersion before a resume call',
          'Showing the user a run — pass `present: true` to render a live card inline',
          'Reading the output of one task, by id, with `taskOutput` — the findings, the diff, ' +
            "the checks a review or a harness task returned. Read it only when the run's " +
            'promoted result is not enough; it can be large.',
        ],
        whenNotToUse: ['Listing runs across a workflow — use a workflow.list-style op'],
        pitfalls: [
          'pauseVersion in the contract is freshly injected; always call detail before resume.',
          'Only pass `present: true` when you intend to show the user; bare observation calls should omit it to avoid card spam.',
        ],
        minimalExampleInput: { runId: '00000000-0000-0000-0000-000000000000' },
      },
      accessMode: 'read',
      inputZod: WorkflowRunDetailInputSchema,
      outputZod: WorkflowRunDetailOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'run',
      verb: 'list_attention',
      name: 'List Workflow Run Attention',
      actionLabel: 'Listing pending attention items…',
      semanticDescription:
        'List pending attention items written by the workflow harness on terminal/pause/cancel events. ' +
        'Used by Helmsman to surface paused or completed runs that need follow-up. Filterable by kind; ' +
        'pending-only by default.',
      tags: ['workflow', 'run', 'attention', 'observe'],
      idempotency: 'idempotent',
      mutates: false,
      usage: {
        oneLine: 'List attention items for workflow runs (paused/completed/failed/cancelled).',
        whenToUse: [
          'Surfacing paused runs that may need user follow-up',
          'Reporting recent completions / failures to the user',
        ],
        whenNotToUse: ['Subscribing to live run events — this is poll-only'],
        pitfalls: ['Items remain pending until consumed; mark consumed once surfaced.'],
        minimalExampleInput: {},
      },
      accessMode: 'read',
      inputZod: WorkflowRunListAttentionInputSchema,
      outputZod: WorkflowRunListAttentionOutputSchema,
    },

    {
      stepType: 'workflow',
      group: 'campaign',
      verb: 'start',
      name: 'Start Campaign',
      actionLabel: 'Starting campaign…',
      semanticDescription:
        'Create (or idempotently return) the active campaign for a skill — the operator-facing ' +
        'instance of the skill: (skill × identity × config). For campaign-contracted skills, ' +
        '`config` is validated field-by-field against the manifest contract (the schema rides ' +
        '`workflow.run.start`’s CAMPAIGN_REQUIRED error details). Identity fields partition the ' +
        'ledger: different identity values are a different campaign. Idempotent on identity — an ' +
        'existing active campaign with identical config is returned as-is; differing non-identity ' +
        'config is rejected with a pointer at workflow.campaign.update (no silent overwrite).',
      tags: ['workflow', 'campaign', 'instance'],
      groupDisplayName: 'Campaign Management',
      groupDescription:
        'Create, read, update, and end campaigns — the operator-facing skill instances that carry ' +
        'typed config, identity, and the goal target across runs.',
      idempotency: 'idempotent',
      mutates: true,
      usage: {
        oneLine: 'Create the skill instance (campaign) once; every later run just selects it.',
        whenToUse: [
          'workflow.run.start rejected with CAMPAIGN_REQUIRED — collect the contract fields and start the campaign',
          'Starting work on a NEW instance (e.g. a second Kaggle competition on the same skill)',
        ],
        whenNotToUse: [
          'Changing config on an existing campaign — use workflow.campaign.update',
          'Per-run values — pass them as workflow.run.start inputs, not campaign config',
        ],
        pitfalls: [
          'config must cover every declared contract field (all are required); values are JSON-Schema validated per field',
          'Identity fields are immutable — to work on a different instance, start another campaign',
        ],
        minimalExampleInput: {
          slug: 'kaggle-competition-optimizer',
          config: { competitionSlug: 'titanic' },
        },
      },
      accessMode: 'write',
      inputZod: WorkflowCampaignStartInputSchema,
      outputZod: WorkflowCampaignStartOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'campaign',
      verb: 'get',
      name: 'Get Campaign',
      actionLabel: 'Loading campaign…',
      semanticDescription:
        'Read one campaign by id: identity, config, status, a direction-aware score summary ' +
        '(best/latest), and the recent score series. Use before workflow.campaign.update to see ' +
        'the current config, or to inspect trajectory for one instance.',
      tags: ['workflow', 'campaign', 'read'],
      idempotency: 'idempotent',
      mutates: false,
      usage: {
        oneLine: 'Read a campaign with config, status, and score summary.',
        whenToUse: [
          'Inspecting one instance’s config and trajectory',
          'Checking current values before a config update',
        ],
        whenNotToUse: ['Discovering which campaigns exist — use workflow.campaign.list'],
        pitfalls: [],
        minimalExampleInput: { campaignId: '00000000-0000-0000-0000-000000000000' },
      },
      accessMode: 'read',
      inputZod: WorkflowCampaignGetInputSchema,
      outputZod: WorkflowCampaignGetOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'campaign',
      verb: 'list',
      name: 'List Campaigns',
      actionLabel: 'Listing campaigns…',
      semanticDescription:
        'List campaigns in the space, optionally filtered by skill slug and status ' +
        '(default: active only). Each entry carries the campaign (identity, config, status) plus ' +
        'a compact score summary. Use this to pick a campaignId when workflow.run.start reports ' +
        'CAMPAIGN_AMBIGUOUS.',
      tags: ['workflow', 'campaign', 'list'],
      idempotency: 'idempotent',
      mutates: false,
      usage: {
        oneLine: 'List campaigns (skill instances) with config and score summaries.',
        whenToUse: [
          'Resolving CAMPAIGN_AMBIGUOUS — show the candidates, pick a campaignId',
          'Reviewing which instances of a skill are active',
        ],
        whenNotToUse: ['Need the full score series for one campaign — use workflow.campaign.get'],
        pitfalls: [
          'Default status filter is "active"; pass status: "all" to include ended campaigns',
        ],
        minimalExampleInput: { slug: 'kaggle-competition-optimizer' },
      },
      accessMode: 'read',
      inputZod: WorkflowCampaignListInputSchema,
      outputZod: WorkflowCampaignListOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'campaign',
      verb: 'update',
      name: 'Update Campaign',
      actionLabel: 'Updating campaign…',
      semanticDescription:
        'Mutate `mutable` non-identity config fields on an active campaign (e.g. raise ' +
        'targetScore). Identity fields are rejected — different identity values are a different ' +
        'campaign (start one instead). Each change is ledger-stamped on the campaign ' +
        '(configHistory) so trajectory readers can annotate the moved bar.',
      tags: ['workflow', 'campaign', 'update'],
      idempotency: 'non_idempotent',
      mutates: true,
      usage: {
        oneLine: 'Change mutable campaign config (the bar moves; the campaign does not restart).',
        whenToUse: [
          'Raising or lowering the goal target mid-campaign',
          'Adjusting non-identity config a setup task consumes',
        ],
        whenNotToUse: ['Changing an identity field (e.g. the competition) — start a new campaign'],
        pitfalls: [
          'Only declared, mutable, non-identity fields are accepted; values are JSON-Schema validated',
          'The campaign must be active — ended campaigns are immutable history',
        ],
        minimalExampleInput: {
          campaignId: '00000000-0000-0000-0000-000000000000',
          config: { targetScore: 0.82 },
        },
      },
      accessMode: 'write',
      inputZod: WorkflowCampaignUpdateInputSchema,
      outputZod: WorkflowCampaignUpdateOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'campaign',
      verb: 'end',
      name: 'End Campaign',
      actionLabel: 'Ending campaign…',
      semanticDescription:
        'End an active campaign (status → ended, with a reason). The score series and ledger ' +
        'remain readable; a later run for the same instance starts a fresh campaign. Idempotent: ' +
        'ending an already-ended campaign returns it unchanged.',
      tags: ['workflow', 'campaign', 'end'],
      idempotency: 'idempotent',
      mutates: true,
      usage: {
        oneLine: 'Close out a skill instance (goal met, abandoned, or superseded).',
        whenToUse: [
          'The operator is done with this instance',
          'Re-baselining: end the old campaign before starting a fresh pursuit',
        ],
        whenNotToUse: [
          'Pausing iteration — campaigns carry no scheduling; just stop starting runs',
        ],
        pitfalls: [],
        minimalExampleInput: { campaignId: '00000000-0000-0000-0000-000000000000' },
      },
      accessMode: 'write',
      inputZod: WorkflowCampaignEndInputSchema,
      outputZod: WorkflowCampaignEndOutputSchema,
    },
    {
      stepType: 'workflow',
      group: 'campaign',
      verb: 'refresh',
      name: 'Refresh Campaign',
      actionLabel: 'Refreshing campaign…',
      semanticDescription:
        'Clear campaign-scoped memo entries so once-per-campaign setup tasks (memo: "campaign") ' +
        're-execute on the next run — e.g. re-download competition data. Pass taskIds to clear ' +
        'selectively; omit to clear all. Target the campaign by id, or by slug when exactly one ' +
        'campaign is active for the skill.',
      tags: ['workflow', 'campaign', 'refresh'],
      idempotency: 'idempotent',
      mutates: true,
      usage: {
        oneLine: 'Force campaign-scoped setup tasks to re-execute on the next run.',
        whenToUse: [
          'Underlying per-campaign state went stale (data updated upstream)',
          'A setup task’s replayed output is suspected wrong',
        ],
        whenNotToUse: [
          'Changing config — workflow.campaign.update already invalidates affected memos',
        ],
        pitfalls: [
          'Clearing is idempotent — refreshing a campaign with no memo entries is a no-op',
        ],
        minimalExampleInput: { slug: 'kaggle-competition-optimizer' },
      },
      accessMode: 'write',
      inputZod: WorkflowCampaignRefreshInputSchema,
      outputZod: WorkflowCampaignRefreshOutputSchema,
    },

    // --- workflow.evaluate ---
    {
      stepType: 'workflow',
      group: null,
      verb: 'evaluate',
      name: 'Evaluate Workflow',
      actionLabel: 'Evaluating outcomes\u2026',
      semanticDescription:
        'Evaluate workflow outcomes against collected metrics. Records evaluation on the ledger ' +
        'entry if runId is provided. If all outcomes are met, also finalizes the run as completed.',
      tags: ['workflow', 'evaluate'],
      outputSemanticType: 'workflow_evaluation',
      idempotency: 'non_idempotent',
      mutates: true,
      usage: {
        oneLine: 'Evaluate workflow outcomes against collected metrics.',
        whenToUse: [
          'After all tasks complete to check if outcomes are met',
          'Mid-run checkpoint to assess progress',
        ],
        whenNotToUse: ['Adding learnings — use workflow.learn'],
        pitfalls: ['Provide all relevant metrics in the input — only declared metrics are checked'],
        minimalExampleInput: {
          slug: 'lead-scoring-optimizer',
          metrics: { f1_score: 0.86 },
        },
      },
      accessMode: 'read',
      inputZod: WorkflowEvaluateInputSchema,
      outputZod: WorkflowEvaluateOutputSchema,
    },

    // --- workflow.learn ---
    {
      stepType: 'workflow',
      group: null,
      verb: 'learn',
      name: 'Record Learnings',
      actionLabel: 'Recording learnings\u2026',
      semanticDescription:
        'Record structured learnings from a workflow run into the ledger. Learnings are ' +
        'injected into future runs to guide iteration. Supports categories: worked, failed, ' +
        'discovered, platform, hypothesis, and workflow_adjustment (structural changes).',
      tags: ['workflow', 'learn', 'knowledge'],
      idempotency: 'non_idempotent',
      mutates: true,
      usage: {
        oneLine: 'Record structured learnings from a workflow run.',
        whenToUse: [
          'After completing a run — capture what worked and what failed',
          'Adding hypotheses for the next iteration',
          'Suggesting workflow structural changes (workflow_adjustment category)',
        ],
        whenNotToUse: ['Simple one-off insight — just note it in the chat'],
        pitfalls: [
          'Observation is capped at 300 chars — be concise',
          'Include runId to ground learnings to a specific run',
        ],
        minimalExampleInput: {
          slug: 'lead-scoring-optimizer',
          runId: '00000000-0000-0000-0000-000000000000',
          learnings: [
            {
              id: 'l-001',
              category: 'worked',
              kind: 'search_heuristic',
              observation: 'Calibrated probabilities improved F1 by 0.03',
              confidence: 'high',
              source: 'agent',
            },
          ],
        },
      },
      accessMode: 'write',
      inputZod: WorkflowLearnInputSchema,
      outputZod: WorkflowLearnOutputSchema,
    },

    // --- workflow.ledger.get ---
    {
      stepType: 'workflow',
      group: 'ledger',
      verb: 'get',
      name: 'Get Workflow Ledger',
      actionLabel: 'Loading ledger\u2026',
      semanticDescription:
        'Get the run history and learnings for a workflow. Returns a compact per-run trajectory ' +
        '(runId, status, timing, learningCount, costCents, score) plus active learnings by ' +
        'default. The heavy entries (full taskResults + evaluation + learnings per run) are ' +
        'opt-in via includeEntries; page back through older runs with the before / nextCursor ' +
        'cursor. Use this to review what has been tried and learned.',
      tags: ['workflow', 'ledger', 'history', 'learnings'],
      outputSemanticType: 'workflow_ledger',
      groupDisplayName: 'Workflow Ledger',
      groupDescription: 'Read-only access to workflow run history and accumulated learnings.',
      idempotency: 'idempotent',
      mutates: false,
      usage: {
        oneLine: 'Retrieve a compact run trajectory (entries opt-in) and learnings for a workflow.',
        whenToUse: [
          'Reviewing what has been tried and what was learned',
          'Preparing context for the next iteration',
          'Analyzing metric trends across runs (the trajectory carries per-run score)',
        ],
        whenNotToUse: ['Need quick status — workflow.manage.get includes a ledger summary'],
        pitfalls: [
          'The default response is compact: entries is empty unless includeEntries=true. For one run’s full detail prefer workflow.run.detail({ runId }).',
          'Page back with before = the previous response’s nextCursor (pass it verbatim — it is an opaque cursor, not a timestamp).',
        ],
        minimalExampleInput: { slug: 'lead-scoring-optimizer' },
      },
      accessMode: 'read',
      inputZod: WorkflowLedgerGetInputSchema,
      outputZod: WorkflowLedgerGetOutputSchema,
    },
  ];
}
