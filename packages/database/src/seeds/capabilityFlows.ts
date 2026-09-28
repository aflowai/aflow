import type postgres from 'postgres';

import { listTenantSchemas } from '../tenant.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Model aliases available in the platform's model catalog.
 * These are the short aliases that resolve to full model IDs at runtime.
 * Keep in sync with packages/ai-client/src/catalog.ts aliases.
 */
const MODEL_ENUM = [
  // Frontier — reliable tool calling + agentic workflows
  'flash', // the current Gemini flash tier
  'pro', // max Google intelligence
  'sonnet', // best agent reliability
  'gpt', // OpenAI flagship
  // Cost-effective — still capable of reliable tool use
  'gpt-mini', // OpenAI cost tier
  'flash-lite', // Google cost tier
  'haiku', // Anthropic cost tier
  // Budget — agentic-capable at lower cost
  'deepseek-flash', // 1M ctx, reasoning
  'mistral-pro', // EU-safe, strong function calling
] as const;

// ============================================================================
// Embedded system prompts (from seeds/prompts/*.md)
// ============================================================================

// ============================================================================
// Flow definition builders
// ============================================================================

interface StateVariable {
  variableId: string;
  name: string;
  typeSchema: Record<string, unknown>;
  semanticType?: string;
  inputRole?: 'primary' | 'config';
  defaultValue?: unknown;
  lifecycle: { isInput: boolean; isOutput: boolean; persistOnPause: boolean };
}

function agentStateVariables(): StateVariable[] {
  return [
    {
      variableId: 'result',
      name: 'Result',
      typeSchema: { type: 'string' },
      semanticType: 'json',
      lifecycle: { isInput: false, isOutput: true, persistOnPause: true },
    },
    {
      variableId: 'prompt',
      name: 'Prompt',
      typeSchema: { type: 'string' },
      semanticType: 'text',
      inputRole: 'primary',
      lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
    },
    {
      variableId: 'model',
      name: 'Model',
      typeSchema: { type: 'string', enum: [...MODEL_ENUM] },
      semanticType: 'text',
      inputRole: 'config',
      defaultValue: 'haiku',
      lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
    },
  ];
}

export interface CapabilityFlowDefinition {
  schemaVersion: number;
  flowId: string;
  metadata: {
    name: string;
    description: string;
    tags: string[];
    system: boolean;
  };
  stateVariables: StateVariable[];
  steps: Array<Record<string, unknown>>;
  startStepId: string;
  supportedModes: string[];
}

function buildMcpRunner(): CapabilityFlowDefinition {
  return {
    schemaVersion: 1,
    flowId: 'mcp-runner',
    metadata: {
      name: 'MCP Operation Runner',
      description:
        'System flow that executes a single operation by operationId. Used by MCP tools (catalog, run_operation).',
      tags: ['system', 'mcp'],
      system: true,
    },
    stateVariables: [
      {
        variableId: 'operationId',
        name: 'Operation ID',
        typeSchema: { type: 'string' },
        lifecycle: { isInput: true, isOutput: false, persistOnPause: false },
      },
      {
        variableId: 'inputs',
        name: 'Operation Inputs',
        typeSchema: { type: 'object' },
        lifecycle: { isInput: true, isOutput: false, persistOnPause: false },
      },
      {
        variableId: 'result',
        name: 'Result',
        typeSchema: {},
        semanticType: 'json',
        lifecycle: { isInput: false, isOutput: true, persistOnPause: false },
      },
    ],
    steps: [
      {
        stepId: 'run',
        stepType: 'agent',
        operation: 'agent.control.run_step',
        name: 'Execute Operation',
        config: { operationId: '${input.operationId}', inputs: '${input.inputs}' },
        outputMapping: { result: 'state.result' },
        onSuccess: { next: [] },
        onFailure: { next: [] },
      },
    ],
    startStepId: 'run',
    supportedModes: ['mcp'],
  };
}

// ============================================================================

const WORKFLOW_AGENT_STEP_TYPES: string[] = ['workflow', 'memory', 'agent', 'api', 'compute'];

const PROMPT_WORKFLOW_AGENT = `You are the Aflow Workflow Agent — a specialized agent that manages the full workflow lifecycle: defining workflows, starting runs, evaluating outcomes, and recording learnings.

## What you do

You help users translate their goals into structured workflows and execute them iteratively:

1. **Define** — Create workflows with measurable outcomes, tasks, and iteration policy
2. **Execute** — Start workflow runs; the harness owns task dispatch
3. **Evaluate** — Check outcomes against collected metrics
4. **Learn** — Record structured learnings that improve future iterations

## Workflow model

A **workflow** is a single entity combining:
- **Outcomes**: Measurable success conditions (threshold, pattern, judge, manual)
- **Tasks**: Atomic work units (delegated to agents or direct operations)
- **Mode**: optimization (same tasks, improve via learnings), process (different input each run), project (one-shot)
- **Learnings**: Structured insights accumulated across runs

## Lifecycle

### Defining (design-time)
1. **Understand** — What does the user want to achieve? How will they know it's done?
2. **Choose mode** — optimization (iterate to improve), process (recurring), project (one-shot)
3. **Set outcomes** — threshold metrics, pattern matches, LLM judge rubrics, or manual
4. **Define tasks** — each task has a goal, optional agent/operation assignment, dependencies
5. **Write it** — Call \`workflow.manage.put\` to create the workflow. It is created as a draft; \`put\` never replaces an existing workflow.
6. **Approval** — The operator approves the draft from the skill page; it cannot run until then. Tell the user it is waiting for their approval. Agents do not approve workflows.

### Editing an existing workflow
- **Small change** (bump budget, rename, retune one task) → \`workflow.manage.patch\` with RFC 6902 ops:
  - Bump run budget: \`[{ "op": "replace", "path": "/budget/maxRuns", "value": 30 }]\`
  - Mark completed: \`[{ "op": "replace", "path": "/status", "value": "completed" }]\`
- **Definition change** (tasks, outcomes, iteration) → \`workflow.manage.patch\` as well; it is staged as a proposal the operator ratifies. Setting \`/status\` to \`approved\` is refused — approving is the operator's.
- Use \`expectedRevision\` on a patch for optimistic concurrency when other writers may be active.

### Executing (run-time)
1. **Load context** — \`workflow.manage.get\` returns workflow + ledger summary (including a \`budget\` block with maxRuns/runsUsed/runsRemaining/exceeded) and active learnings. This is the one-stop status call; do not fall back to \`memory.store.query\` for workflow state.
2. **Start run** — \`workflow.run.start\` registers the run; the harness dispatches tasks
3. **During the run** — the harness drives task dispatch; the agent observes via attention items
4. **Evaluate** — \`workflow.evaluate\` checks outcomes against collected metrics
5. **Learn** — \`workflow.learn\` records 0-3 structured insights per run
6. **Report** — Summarize: outcome status, learnings, recommended next steps

## Guidelines

**Defining workflows:**
- Keep slugs short and descriptive (e.g., "kaggle-housing", "daily-report")
- Optimization mode: MUST have at least one threshold outcome with a numeric target
- Each task needs a clear goal describing what it should achieve
- Tasks can reference agents (for delegation) or operations (for direct execution)

**Recording learnings:**
- Be specific — cite metrics, compare to prior runs, explain causality
- Categories: worked, failed, discovered, platform, hypothesis, workflow_adjustment
- workflow_adjustment learnings suggest structural changes (add/remove/modify tasks)
- Observation max 300 chars — concise and actionable
- "No new learnings" is valid if nothing materially changed

## Error handling

- If you encounter 2+ consecutive errors on the same operation or task, **stop retrying**. Do not attempt more than 3 different approaches for the same problem.
- Summarize what you tried, what errors you saw, and what you think the root cause is.
- Record the task as "blocked" with a clear description of the issue, then ask the user for guidance.
- **Platform errors** (sandbox failures, missing capabilities, internal errors) are not your fault — flag them immediately rather than trying workarounds.
- When API endpoint tools are available (promoted from catalog.tool.search), call them directly by name. Do not use api.http.call as a wrapper.`;

function buildWorkflowAgent(): CapabilityFlowDefinition {
  const stateVariables = agentStateVariables().map((v) =>
    v.variableId === 'model' ? { ...v, defaultValue: 'sonnet' as const } : v,
  );
  return {
    schemaVersion: 1,
    flowId: 'workflow-agent',
    metadata: {
      name: 'Workflow Agent',
      description:
        'Specialized agent that manages the full workflow lifecycle — defining workflows, starting runs, evaluating outcomes, and recording learnings.',
      tags: ['system', 'workflow'],
      system: true,
    },
    stateVariables: [
      ...stateVariables,
      {
        variableId: 'step_types',
        name: 'Step Types',
        typeSchema: {
          type: 'array',
          items: { type: 'string' },
        },
        semanticType: 'catalog_step_types',
        inputRole: 'config',
        defaultValue: WORKFLOW_AGENT_STEP_TYPES,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: false },
      },
      {
        variableId: 'workflow_slug',
        name: 'Workflow Slug',
        typeSchema: { type: 'string' },
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: false },
      },
    ],
    steps: [
      {
        stepId: 'agent',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'Workflow Agent',
        config: {
          model: '${state.model}',
          systemPrompt: PROMPT_WORKFLOW_AGENT,
          prompt: '${state.prompt}',
          agentRole: 'assistant',
          catalog: {
            coreOperations: [
              'workflow.manage.put',
              'workflow.manage.patch',
              'workflow.manage.get',
              'workflow.manage.list',
              'workflow.run.start',
              'workflow.run.resume',
              'workflow.evaluate',
              'workflow.learn',
              'workflow.ledger.get',
              'memory.store.put',
              'memory.store.get',
              'memory.store.query',
              'compute.sandbox.exec',
            ],
            discoveryStepId: 'discover',
            discovery: {
              allowedStepTypes: '${state.step_types}' as unknown as string[],
              allowedAgents: true,
            },
            format: 'summary',
          },
          temperature: 0,
          turnPolicy: {
            maxToolCallsPerTurn: 5,
            allowParallel: true,
            allowComplete: true,
          },
        },
        onSuccess: {
          next: [
            { stepId: 'discover', priority: 50 },
            { stepId: 'run-subflow', priority: 50 },
          ],
        },
        onFailure: { next: [{ stepId: 'agent', priority: 50 }] },
      },
      {
        stepId: 'discover',
        stepType: 'catalog',
        operation: 'catalog.tool.search',
        name: 'Discover Tools',
        description:
          'Search for operations by intent. Use when you need a tool not in your current set. Input: { query: "what you want to do" }',
        config: {},
        outputOptions: { displayToUser: true },
        tags: [],
        onSuccess: { next: [{ stepId: 'agent', priority: 50 }] },
        onFailure: { next: [{ stepId: 'agent', priority: 50 }] },
      },
      {
        stepId: 'run-subflow',
        stepType: 'agent',
        operation: 'agent.control.delegate',
        name: 'Delegate to Agent',
        description:
          'Delegate a task to another agent. Used for running workflow tasks via delegation.',
        config: {},
        outputMapping: { result: 'state.result' },
        outputOptions: { displayToUser: true },
        tags: [],
        onSuccess: { next: [{ stepId: 'agent', priority: 50 }] },
        onFailure: { next: [{ stepId: 'agent', priority: 50 }] },
      },
    ],
    startStepId: 'agent',
    supportedModes: ['chat'],
  };
}

// ============================================================================
// All capability flows
// ============================================================================

/**
 * The 6 capability flow definitions.
 * Exported so `scripts/seed-flows.ts` (API-based dev seeder) uses the same source of truth.
 */
// ============================================================================

/** Step types the ML prediction agent discovers from the catalog. */
const ML_AGENT_STEP_TYPES: string[] = ['compute', 'api', 'memory'];

const PROMPT_ML_PREDICTION = `You are an ML Prediction Agent — a specialized sub-agent that helps users build, train, and evaluate tabular machine learning models through iterative experimentation.

## What you do

You run the full ML optimization loop: explore data → engineer features → train models → evaluate → iterate → present results. You use the \`compute.sandbox.exec\` operation with the \`python3-ml\` runtime to execute Python code in a sandboxed environment.

## Available tools

### Code execution
Use \`compute.sandbox.exec\` with \`runtime: "python3-ml"\` to run Python code. The sandbox has these libraries pre-installed:
- **pandas** — data loading, manipulation, feature engineering
- **numpy** — numerical operations
- **scikit-learn** — model training, evaluation, preprocessing
- **xgboost** — gradient boosting (often best for tabular data)
- **lightgbm** — fast gradient boosting alternative
- **scipy** — statistical functions
- **matplotlib** — plotting (save figures to /tmp/output/)

### Data handling
- Use \`api.http.request\` to download datasets from external APIs
- Use \`memory.store.*\` to persist experiment results and findings across runs

## Critical rules

1. **NEVER request raw data in your response.** Data stays in the compute sandbox. You see only metrics, summaries, and sample rows.
2. **Always use \`entryPoint\` pattern** for structured I/O: define a function that returns a dict, and pass arguments via \`args\`. The return value appears in the \`result\` field.
3. **Print progress** to stdout (it appears in the step output), but return metrics as structured JSON via the entry point.
4. **Increase resource limits** for training: set \`limits.timeoutSeconds\` to 120-300 and \`limits.memoryMB\` to 512-2048 depending on dataset size.

## Workflow pattern

### Phase 1: Explore
\`\`\`
compute.sandbox.exec:
  runtime: python3-ml
  entryPoint: explore
  code: |
    import pandas as pd
    def explore():
        # Load data from files input
        df = pd.read_csv('/tmp/data.csv')
        return {
            "rows": len(df),
            "columns": list(df.columns),
            "dtypes": {c: str(df[c].dtype) for c in df.columns},
            "sample": df.head(3).to_dict(orient='records'),
            "nulls": df.isnull().sum().to_dict(),
            "stats": df.describe().to_dict()
        }
  files:
    data.csv: <loaded via prior api.http.request or provided by user>
\`\`\`

### Phase 2: Train & Evaluate
\`\`\`
compute.sandbox.exec:
  runtime: python3-ml
  entryPoint: train_and_evaluate
  args: [{ features: [...], target: "...", model: "xgboost", test_years: [2024, 2025] }]
  limits: { timeoutSeconds: 300, memoryMB: 1024 }
  code: |
    import pandas as pd, numpy as np, json
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import brier_score_loss, accuracy_score
    import xgboost as xgb

    def train_and_evaluate(config):
        df = pd.read_csv('/tmp/data.csv')
        # ... feature engineering, train/test split, model training ...
        return {
            "model": config["model"],
            "features": config["features"],
            "metrics": {
                "brier_score": float(brier),
                "accuracy": float(acc),
                "train_samples": len(X_train),
                "test_samples": len(X_test)
            },
            "feature_importance": importance_dict
        }
\`\`\`

### Phase 3: Compare & Decide
After training multiple candidates, compare their metrics:
- If a candidate meets the target metric → present to user for approval
- If within 5% of target and fewer than 3 candidates tried → auto-retry with adjusted features/hyperparams
- If 3+ candidates plateau at similar scores → suggest a fundamentally different approach
- Always present a comparison table of all candidates tried

### Phase 4: Present Results
Always use \`user.interaction.ask\` before accepting final results. Present:
- Best candidate's metrics with comparison to baseline
- Feature importance ranking
- All candidates tried with metrics
- Recommended next steps

## Decision policy

| Situation | Action |
|-----------|--------|
| Meets target metric | Present for user approval |
| Within 5% of target, <3 tried | Auto-retry with adjusted features/hyperparams |
| Within 5% of target, 3+ tried | Ask user: accept best or try different approach? |
| >20% below target | Diagnose: data issue? wrong model? insufficient features? |
| Candidates plateau (±2%) | Suggest fundamentally different approach |
| Code execution fails | Fix the error and retry (common: import errors, dtype mismatches) |

## Hyperparameter adjustment strategy

1. Start with XGBoost defaults + reasonable feature set
2. If underfitting → increase max_depth, n_estimators
3. If overfitting → decrease max_depth, increase min_child_weight, add regularization
4. If plateau → try different features, not more hyperparameter tuning
5. Consider LightGBM as alternative — often faster with similar accuracy

## File I/O in the sandbox

- Input files: pass via \`files\` field (key = filename, value = content string)
- Output files: write to \`/tmp/output/\` — they appear in \`outputFiles\` in the result
- Large data: if data is too large for \`files\` field, have the user provide a URL and download via api.http.request first, then pass the response data through

## Important: resource limits

The sandbox has conservative defaults. For ML workloads, always set:
- \`limits.timeoutSeconds: 300\` (5 min for training, up from 60s default)
- \`limits.memoryMB: 1024\` (1GB for datasets, up from 256MB default)
- For large datasets: \`limits.memoryMB: 2048\` or higher`;

function buildMlPredictionAgent(): CapabilityFlowDefinition {
  return {
    schemaVersion: 1,
    flowId: 'ml-prediction-agent',
    metadata: {
      name: 'ML Prediction Agent',
      description:
        'Specialized agent for tabular ML: feature engineering, model training (XGBoost/LightGBM/sklearn), evaluation, and iterative optimization via compute sandbox.',
      tags: ['system', 'sub-agent', 'ml'],
      system: true,
    },
    stateVariables: [
      ...agentStateVariables(),
      {
        variableId: 'step_types',
        name: 'Step Types',
        typeSchema: {
          type: 'array',
          items: { type: 'string' },
        },
        semanticType: 'catalog_step_types',
        inputRole: 'config',
        defaultValue: ML_AGENT_STEP_TYPES,
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true },
      },
    ],
    steps: [
      {
        stepId: 'agent',
        stepType: 'ai',
        operation: 'ai.agent.turn',
        name: 'ML Prediction Agent',
        config: {
          model: '${state.model}',
          agentRole: 'assistant',
          systemPrompt: PROMPT_ML_PREDICTION,
          prompt: '${state.prompt}',
          contextProfile: 'default',
          temperature: 0,
          turnPolicy: {
            maxToolCallsPerTurn: 3,
            allowParallel: false,
            allowComplete: false,
          },
          catalog: {
            coreOperations: [
              'memory.store.put',
              'memory.store.get',
              'memory.store.query',
              'compute.sandbox.exec',
              'api.http.call',
              'search.web.search',
            ],
            discovery: {
              allowedStepTypes: '${state.step_types}' as unknown as string[],
            },
          },
        },
        onSuccess: {
          next: [{ stepId: 'run-subflow', priority: 50 }],
        },
        onFailure: { next: [{ stepId: 'agent', priority: 50 }] },
      },
      {
        stepId: 'run-subflow',
        stepType: 'agent',
        operation: 'agent.control.delegate',
        name: 'Delegate to Sub-Agent',
        description:
          'Delegate tasks to another agent. Input: { flowId: string, input: { prompt: string }, wait: boolean }',
        config: {
          flowId: '${input.flowId}',
          input: '${input.input}',
        },
        outputMapping: { result: 'state.result' },
        outputOptions: { displayToUser: true },
        tags: [],
        onSuccess: { next: [{ stepId: 'agent', priority: 50 }] },
        onFailure: { next: [{ stepId: 'agent', priority: 50 }] },
      },
    ],
    startStepId: 'agent',
    supportedModes: ['chat', 'mcp'],
  };
}

export const CAPABILITY_FLOWS: CapabilityFlowDefinition[] = [
  buildMcpRunner(),
  buildWorkflowAgent(),
];

/** Exported for standalone creation via scripts/create-ml-agent.ts (not seeded into General). */
export const ML_PREDICTION_AGENT = buildMlPredictionAgent();

const FLOW_VERSION = '1';

const SYSTEM_ROLE_BY_FLOW_ID: Record<string, string> = {
  'mcp-runner': 'mcp-runner',
};

// ============================================================================
// Seed function
// ============================================================================

/**
 * Seed capability flows into all tenant schemas.
 *
 * For each tenant schema:
 * 1. Find the "general" space (created by migration 13)
 * 2. Delete any user-edited versions of capability agents (non-system copies
 *    that shadow the canonical seed — see comment in upsert loop)
 * 3. Upsert all capability flows with ON CONFLICT (agent_id, version) DO UPDATE
 *
 * Safe to re-run on every deploy — uses idempotent upserts.
 */
export async function seedCapabilityFlows(sqlClient: postgres.Sql): Promise<{
  success: string[];
  skipped: string[];
  failed: Array<{ schema: string; error: unknown }>;
}> {
  const tenants = await listTenantSchemas(sqlClient);

  const results: {
    success: string[];
    skipped: string[];
    failed: Array<{ schema: string; error: unknown }>;
  } = {
    success: [],
    skipped: [],
    failed: [],
  };

  for (const tenant of tenants) {
    try {
      await seedFlowsForTenant(sqlClient, tenant.schemaName);
      results.success.push(tenant.schemaName);
    } catch (err) {
      results.failed.push({ schema: tenant.schemaName, error: err });
    }
  }

  return results;
}

async function seedFlowsForTenant(sqlClient: postgres.Sql, schemaName: string): Promise<void> {
  // Find the "general" space
  const spaceRows = await sqlClient.unsafe(
    `SELECT id FROM "${schemaName}".spaces WHERE slug = 'general' LIMIT 1`,
  );

  const spaceRow = spaceRows[0] as { id: string } | undefined;
  if (!spaceRow) {
    // No general space means migration 13 hasn't run — skip this tenant
    // (applyMigrationsToAllTenants runs before this, so this should be rare)
    throw new Error(`No "general" space found in schema ${schemaName}`);
  }

  const spaceId = spaceRow.id;

  // Upsert each flow — use tagged template for correct JSONB handling.
  // postgres.js .unsafe() with positional params double-encodes JSON strings,
  // but .unsafe() with schema-qualified table names is needed for dynamic schemas.
  // Workaround: use a two-step approach with a schema SET.
  await sqlClient.unsafe(`SET search_path TO "${schemaName}"`);
  try {
    const flowIds = CAPABILITY_FLOWS.map((f) => f.flowId);

    // Delete user-edited versions of capability agents. When a system agent is
    // edited via the API (ALLOW_SYSTEM_AGENT_EDIT), a new version is created with
    // created_by != 'system' and metadata.system stripped. These shadow the
    // canonical v1 in queries (ORDER BY created_at DESC, first-seen-wins dedup).
    // Re-seeding should restore canonical definitions, so purge non-system versions.
    await sqlClient`
      DELETE FROM agent_definitions
      WHERE agent_id = ANY(${flowIds})
        AND created_by != 'system'`;

    for (const flow of CAPABILITY_FLOWS) {
      const name = flow.metadata.name;
      const flowWithRole = SYSTEM_ROLE_BY_FLOW_ID[flow.flowId]
        ? { ...flow, systemRole: SYSTEM_ROLE_BY_FLOW_ID[flow.flowId] }
        : flow;

      await sqlClient`
        INSERT INTO agent_definitions (agent_id, version, name, definition_json, created_by, status, space_id)
        VALUES (${flow.flowId}, ${FLOW_VERSION}, ${name}, ${sqlClient.json(flowWithRole as never)}, 'system', 'published', ${spaceId}::uuid)
        ON CONFLICT (agent_id, version) DO UPDATE SET
          name = EXCLUDED.name,
          definition_json = EXCLUDED.definition_json,
          status = 'published',
          space_id = EXCLUDED.space_id`;
    }
  } finally {
    await sqlClient.unsafe(`SET search_path TO public`);
  }
}
