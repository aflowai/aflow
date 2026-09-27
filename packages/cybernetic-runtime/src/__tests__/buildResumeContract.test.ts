import { describe, expect, it } from 'vitest';
import {
  WorkflowResumeContractSchema,
  WorkflowRunPauseReasonSchema,
  type SubagentHandoffPayload,
} from '@aflow/schemas';
import { buildResumeContract, BUILD_RESUME_CONTRACT_HANDLED_CAUSES } from '../workflowResume.js';

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const TASK_ID = 'submit-call';

const MISSING_INPUT_HANDOFF: SubagentHandoffPayload = {
  payloadKind: 'subagent_handoff',
  handoffSource: 'runner-signal-blocked',
  prompt: 'Need the user to pick a competition name.',
  blockingCategory: 'missing_input',
};

const EXTERNAL_DEPENDENCY_HANDOFF: SubagentHandoffPayload = {
  payloadKind: 'subagent_handoff',
  handoffSource: 'runner-signal-blocked',
  prompt: 'Kaggle MCP unreachable — retry once connectivity is back.',
  blockingCategory: 'external_dependency',
};

/** Production signal_blocked pauses pass the live task-row attempt (typically 1). */
const PAUSED_ATTEMPT = 1;

describe('buildResumeContract — Plan 171 §2.2.2 decision table', () => {
  describe('subagent_handoff / missing_input', () => {
    it('routes to provide_input with the per-task input schema derived from inputContract.bindings', () => {
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
          inputContract: {
            bindings: {
              competitionName: {
                kind: 'run_input',
                schema: { type: 'string', minLength: 1 },
              },
            },
          },
        } as never,
        handoff: MISSING_INPUT_HANDOFF,
      });
      expect(contract.pauseCause).toBe('subagent_handoff');
      expect(contract.allowedResumeModes).toEqual(['provide_input', 'fail']);
      expect(contract.suggestedResumeCall?.op).toBe('workflow.run.resume');
      const args = contract.suggestedResumeCall?.args as Record<string, unknown>;
      const resolution = args['resolution'] as Record<string, unknown>;
      expect(resolution['mode']).toBe('provide_input');
      expect(resolution['taskId']).toBe(TASK_ID);
      // pausedTaskInputContract carries the per-port `run_input` schema,
      // keyed by bindAs.
      const ptic = contract.pausedTaskInputContract;
      expect(ptic?.resolutionMode).toBe('provide_input');
      const props = (ptic?.schema as Record<string, unknown>)['properties'] as Record<
        string,
        unknown
      >;
      expect(props['competitionName']).toBeDefined();
    });

    it('omits pausedTaskInputContract when the task has no run_input bindings', () => {
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: null,
        handoff: MISSING_INPUT_HANDOFF,
      });
      expect(contract.allowedResumeModes).toEqual(['provide_input', 'fail']);
      expect(contract.pausedTaskInputContract).toBeUndefined();
    });
  });

  describe('subagent_handoff / non-missing_input (the §1.1 Kaggle case)', () => {
    it('omits re_execute when attempt >= maxAttempts (omitted maxAttempts defaults to 3)', () => {
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: null,
        handoff: EXTERNAL_DEPENDENCY_HANDOFF,
        // Default budget is 3 (Plan 202 §3.0); attempt 3 ⇒ exhausted.
        pausedTaskAttempt: 3,
      });
      expect(contract.allowedResumeModes).toEqual(['fail']);
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('fail');
    });

    it('Plan 202 §3.0 — offers re_execute at attempt 1 with omitted maxAttempts (default 3)', () => {
      // The dogfood win: a paused task that never spelled `maxAttempts` must
      // still accept a deliberate re_execute. Old default 1 refused every
      // first re_execute; default 3 leaves 2 attempts of headroom.
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
        } as never,
        handoff: EXTERNAL_DEPENDENCY_HANDOFF,
        pausedTaskAttempt: 1,
      });
      expect(contract.allowedResumeModes).toEqual(['re_execute', 'fail']);
    });

    it('routes to re_execute when retry budget remains', () => {
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
          maxAttempts: 3,
        } as never,
        handoff: EXTERNAL_DEPENDENCY_HANDOFF,
        pausedTaskAttempt: PAUSED_ATTEMPT,
      });
      expect(contract.allowedResumeModes).toEqual(['re_execute', 'fail']);
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('re_execute');
      expect(contract.pausedTaskInputContract?.resolutionMode).toBe('re_execute');
    });

    it('Plan 171 review fix — unsafe task surfaces remediationConfirmed schema requirement + prompt warning', async () => {
      // Codex-bot finding (PR 392): when the failed task is `retryability: 'unsafe'`,
      // the surfaced re_execute call was rejected by the resume handler unless
      // `remediationConfirmed: true` is added. The contract must surface this gate
      // both in the pausedTaskInputContract.schema (REQUIRED flag) AND in the
      // prompts so Helmsman knows to obtain operator confirmation before adding it.
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit to Kaggle',
          goal: 'g',
          type: 'agent',
          retryability: 'unsafe',
          maxAttempts: 3,
        } as never,
        handoff: EXTERNAL_DEPENDENCY_HANDOFF,
        pausedTaskAttempt: PAUSED_ATTEMPT,
      });
      // Suggested call still omits remediationConfirmed — Helmsman MUST add
      // it explicitly so it can't rubber-stamp the gate by copying verbatim.
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution).toEqual({ mode: 're_execute' });
      // Schema marks remediationConfirmed as REQUIRED with const: true.
      const schema = contract.pausedTaskInputContract?.schema as Record<string, unknown>;
      expect(schema['required']).toContain('remediationConfirmed');
      const props = schema['properties'] as Record<string, unknown>;
      const rc = props['remediationConfirmed'] as Record<string, unknown>;
      expect(rc['type']).toBe('boolean');
      expect(rc['const']).toBe(true);
      // Prompts call out the requirement explicitly.
      expect(contract.resumePrompt).toContain('remediationConfirmed: true');
      expect(contract.resumePrompt).toContain('unsafe');
      expect(contract.pausedTaskInputContract?.prompt).toContain('remediationConfirmed: true');
    });

    it('Plan 171 review fix — `retryability: unknown` (or omitted) also triggers the unsafe gate', () => {
      // The resume handler defaults omitted retryability to `'unknown'`,
      // which then trips the gate. The contract must mirror that.
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
          maxAttempts: 3,
          // retryability intentionally omitted
        } as never,
        handoff: EXTERNAL_DEPENDENCY_HANDOFF,
        pausedTaskAttempt: PAUSED_ATTEMPT,
      });
      const schema = contract.pausedTaskInputContract?.schema as Record<string, unknown>;
      expect(schema['required']).toContain('remediationConfirmed');
      expect(contract.resumePrompt).toContain('unknown');
    });

    it('safe task omits the gate so Helmsman can copy the call verbatim', () => {
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Idempotent fetch',
          goal: 'g',
          type: 'agent',
          retryability: 'safe',
          maxAttempts: 3,
        } as never,
        handoff: EXTERNAL_DEPENDENCY_HANDOFF,
        pausedTaskAttempt: PAUSED_ATTEMPT,
      });
      const schema = contract.pausedTaskInputContract?.schema as Record<string, unknown>;
      // No `required` array on the safe-task schema.
      expect(schema['required']).toBeUndefined();
      // Prompt is the original handoff text without the unsafe annotation.
      expect(contract.resumePrompt).not.toContain('remediationConfirmed');
      expect(contract.resumePrompt).not.toContain('unsafe');
    });
  });

  describe('transient_error', () => {
    it('routes to re_execute and surfaces errorMessage + errorCode', () => {
      const contract = buildResumeContract({
        pauseCause: 'transient_error',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
          maxAttempts: 3,
        } as never,
        errorMessage: 'Kaggle MCP timeout after 30s',
        errorCode: 'MCP_TIMEOUT',
        pausedTaskAttempt: PAUSED_ATTEMPT,
      });
      expect(contract.allowedResumeModes).toEqual(['re_execute', 'fail']);
      expect(contract.errorMessage).toBe('Kaggle MCP timeout after 30s');
      expect(contract.errorCode).toBe('MCP_TIMEOUT');
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('re_execute');
    });
  });

  describe('task_contract_violation', () => {
    it('routes to replace_output with re_execute only when retryability is safe', () => {
      const contract = buildResumeContract({
        pauseCause: 'task_contract_violation',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Score',
          goal: 'g',
          type: 'agent',
          retryability: 'safe',
          maxAttempts: 3,
        } as never,
        pausedTaskAttempt: PAUSED_ATTEMPT,
        resumePrompt: 'score-task output failed validation.',
        expectedTaskOutputSchema: {
          type: 'object',
          properties: { score: { type: 'number', minimum: 0, maximum: 1 } },
          required: ['score'],
        },
        replaceOutputSchema: {
          type: 'object',
          properties: { score: { type: 'number', minimum: 0, maximum: 1 } },
          required: ['score'],
        },
      });
      expect(contract.allowedResumeModes).toEqual(['replace_output', 're_execute', 'fail']);
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('replace_output');
      expect(contract.expectedTaskOutputSchema).toBeDefined();
      expect(contract.replaceOutputSchema).toBeDefined();
      expect(contract.pausedTaskInputContract?.resolutionMode).toBe('replace_output');
    });

    it('omits re_execute for unsafe/unknown tasks (replace_output contract lacks re_execute gate)', () => {
      const contract = buildResumeContract({
        pauseCause: 'task_contract_violation',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
          retryability: 'unsafe',
          maxAttempts: 3,
        } as never,
        pausedTaskAttempt: PAUSED_ATTEMPT,
        resumePrompt: 'output failed validation.',
        replaceOutputSchema: {
          type: 'object',
          properties: { ok: { const: true } },
          required: ['ok'],
        },
      });
      expect(contract.allowedResumeModes).toEqual(['replace_output', 'fail']);
      expect(contract.resumePrompt).toContain('not offered');
      expect(contract.resumePrompt).not.toContain('remediationConfirmed');
    });
  });

  describe('retry_budget_exceeded', () => {
    it('routes to replace_output WITHOUT re_execute (budget is gone)', () => {
      const contract = buildResumeContract({
        pauseCause: 'retry_budget_exceeded',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: null,
        resumePrompt: 'maxAttempts reached on submit-call.',
        replaceOutputSchema: {
          type: 'object',
          properties: { submitted: { const: true } },
          required: ['submitted'],
        },
      });
      expect(contract.allowedResumeModes).toEqual(['replace_output', 'fail']);
      expect(contract.allowedResumeModes).not.toContain('re_execute');
    });
  });

  describe('needs_credentials / needs_capability', () => {
    it('needs_credentials routes to acknowledge', () => {
      const contract = buildResumeContract({
        pauseCause: 'needs_credentials',
        runId: RUN_ID,
        blockedBindings: [
          {
            bindingId: 'b-1',
            bindingName: 'kaggle-default',
            missingFields: ['apiKey'],
          },
        ],
      });
      expect(contract.allowedResumeModes).toEqual(['acknowledge', 'fail']);
      expect(contract.blockedBindings?.[0]?.bindingName).toBe('kaggle-default');
      expect(contract.pausedTaskInputContract?.resolutionMode).toBe('acknowledge');
    });

    it('task-backed needs_credentials (mid-run) carries failedTaskId + allows acknowledge', () => {
      const contract = buildResumeContract({
        pauseCause: 'needs_credentials',
        runId: RUN_ID,
        taskId: TASK_ID,
        blockedBindings: [
          { bindingId: 'b-1', bindingName: 'kaggle-default', missingFields: ['apiKey'] },
        ],
      });
      expect(contract.pauseCause).toBe('needs_credentials');
      expect(contract.failedTaskId).toBe(TASK_ID);
      expect(contract.allowedResumeModes).toContain('acknowledge');
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('acknowledge');
    });

    it('needs_capability routes to acknowledge', () => {
      const contract = buildResumeContract({
        pauseCause: 'needs_capability',
        runId: RUN_ID,
        disabledCapabilities: ['mcp:kaggle'],
      });
      expect(contract.allowedResumeModes).toEqual(['acknowledge', 'fail']);
      expect(contract.disabledCapabilities).toEqual(['mcp:kaggle']);
    });

    it('task-backed needs_oauth_consent offers re_execute (re-dispatch the blocked step on callback)', () => {
      const contract = buildResumeContract({
        pauseCause: 'needs_oauth_consent',
        runId: RUN_ID,
        taskId: TASK_ID,
        oauthConsent: {
          integrationKind: 'mcp',
          resourceKey: 'github',
          bindingId: 'bnd-github',
          ownerScope: 'user',
          reason: 'never_connected',
        },
      });
      expect(contract.failedTaskId).toBe(TASK_ID);
      expect(contract.allowedResumeModes).toEqual(['re_execute', 'fail']);
      expect(contract.allowedResumeModes).not.toContain('acknowledge');
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('re_execute');
      expect(contract.pausedTaskInputContract?.resolutionMode).toBe('re_execute');
    });

    it('run-level needs_oauth_consent (no taskId) keeps acknowledge', () => {
      const contract = buildResumeContract({
        pauseCause: 'needs_oauth_consent',
        runId: RUN_ID,
        oauthConsent: {
          integrationKind: 'api',
          resourceKey: 'stripe',
          bindingId: 'bnd-stripe',
          ownerScope: 'space',
          reason: 'expired',
        },
      });
      expect(contract.failedTaskId).toBeUndefined();
      expect(contract.allowedResumeModes).toEqual(['acknowledge', 'fail']);
    });
  });

  describe('manual', () => {
    it('run-level pause (no taskId) suggests acknowledge only — re_execute needs failedTaskId', () => {
      const contract = buildResumeContract({
        pauseCause: 'manual',
        runId: RUN_ID,
        reason: 'Operator paused the whole run.',
      });
      expect(contract.failedTaskId).toBeUndefined();
      expect(contract.allowedResumeModes).toEqual(['acknowledge']);
      expect(contract.allowedResumeModes).not.toContain('re_execute');
      expect(contract.allowedResumeModes).not.toContain('fail');
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('acknowledge');
      expect(contract.resumePrompt).toBe('Operator paused the whole run.');
    });

    it('task-level pause offers re_execute only — acknowledge leaves paused task stuck', () => {
      const contract = buildResumeContract({
        pauseCause: 'manual',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
          maxAttempts: 3,
        } as never,
        reason: 'Operator paused to adjust thresholds.',
        pausedTaskAttempt: PAUSED_ATTEMPT,
      });
      expect(contract.failedTaskId).toBe(TASK_ID);
      expect(contract.allowedResumeModes).toEqual(['re_execute', 'fail']);
      expect(contract.allowedResumeModes).not.toContain('acknowledge');
      const resolution = (contract.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('re_execute');
      expect(contract.resumePrompt).toContain('Operator paused to adjust thresholds.');
      expect(contract.resumePrompt).toContain('remediationConfirmed');
    });

    it('Plan 182 §2.6 — interruptRestart offers re_execute even when the retry budget is spent', () => {
      // A `safe` task on its last allowed attempt (default maxAttempts:3 at
      // attempt 3) would normally advertise only ['fail'] — un-resumable from
      // the UI. An operator interrupt-restart is a human override, so it must
      // still offer re_execute.
      const base = {
        pauseCause: 'manual' as const,
        runId: RUN_ID,
        taskId: TASK_ID,
        // maxAttempts omitted → defaults to 3; pausedTaskAttempt 3 ⇒ budget spent.
        taskDef: {
          taskId: TASK_ID,
          name: 'Execute',
          goal: 'g',
          type: 'agent',
          retryability: 'safe',
        } as never,
        reason: 'Operator interrupted the running task.',
        pausedTaskAttempt: 3,
      };
      // Without the flag: budget spent → fail only.
      expect(buildResumeContract(base).allowedResumeModes).toEqual(['fail']);
      // With interruptRestart: re_execute offered anyway.
      const interrupt = buildResumeContract({ ...base, interruptRestart: true });
      expect(interrupt.allowedResumeModes).toEqual(['re_execute', 'fail']);
      const resolution = (interrupt.suggestedResumeCall?.args as Record<string, unknown>)[
        'resolution'
      ] as Record<string, unknown>;
      expect(resolution['mode']).toBe('re_execute');
    });
  });

  describe('Plan 171 review fix — every emitted contract round-trips through WorkflowResumeContractSchema', () => {
    // Codex bot finding (PR 392): the unsafe-task annotation appended a
    // 600+ char warning to `pausedTaskInputContract.prompt`, which was
    // capped at 500 chars by the schema. The stored contract failed
    // `WorkflowResumeContractSchema.safeParse` at surface time, so
    // `surfaceWorkflowResumeContract` returned null and the envelope
    // lost everything (allowedResumeModes, suggestedResumeCall). These
    // tests pin the round-trip invariant for every branch.

    const LONG_HANDOFF: SubagentHandoffPayload = {
      payloadKind: 'subagent_handoff',
      handoffSource: 'runner-signal-blocked',
      prompt: 'a'.repeat(1200), // long handoff; stays within 2000 after unsafe annotation
      blockingCategory: 'external_dependency',
    };

    it('unsafe-task subagent_handoff round-trips even when handoff.prompt is huge', () => {
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
          retryability: 'unsafe',
          maxAttempts: 3,
        } as never,
        handoff: LONG_HANDOFF,
        pausedTaskAttempt: PAUSED_ATTEMPT,
      });
      const parsed = WorkflowResumeContractSchema.safeParse(contract);
      expect(parsed.success).toBe(true);
      expect((contract.pausedTaskInputContract?.prompt ?? '').length).toBeLessThanOrEqual(2000);
      expect(contract.pausedTaskInputContract?.prompt).toContain('remediationConfirmed');
      expect(contract.resumePrompt).toContain('remediationConfirmed');
    });

    it('bounds pausedTaskInputContract.prompt when handoff + unsafe annotation exceed 2000 chars', () => {
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Submit',
          goal: 'g',
          type: 'agent',
          retryability: 'unsafe',
          maxAttempts: 3,
        } as never,
        handoff: {
          ...LONG_HANDOFF,
          prompt: 'a'.repeat(2500),
        },
        pausedTaskAttempt: PAUSED_ATTEMPT,
      });
      const parsed = WorkflowResumeContractSchema.safeParse(contract);
      expect(parsed.success).toBe(true);
      expect(contract.pausedTaskInputContract?.prompt?.length).toBe(2000);
      expect(contract.pausedTaskInputContract?.prompt?.endsWith('…')).toBe(true);
      // Uncapped resumePrompt keeps the full handoff + annotation.
      expect((contract.resumePrompt ?? '').length).toBeGreaterThan(2000);
    });

    it('missing_input subagent_handoff round-trips when handoff.prompt is huge', () => {
      const contract = buildResumeContract({
        pauseCause: 'subagent_handoff',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: {
          taskId: TASK_ID,
          name: 'Need input',
          goal: 'g',
          type: 'agent',
          inputContract: {
            bindings: {
              x: { kind: 'run_input', schema: { type: 'string' } },
            },
          },
        } as never,
        handoff: { ...LONG_HANDOFF, blockingCategory: 'missing_input' },
      });
      const parsed = WorkflowResumeContractSchema.safeParse(contract);
      expect(parsed.success).toBe(true);
      expect((contract.pausedTaskInputContract?.prompt ?? '').length).toBeLessThanOrEqual(2000);
    });

    it('task_contract_violation round-trips when resumePrompt is huge', () => {
      const contract = buildResumeContract({
        pauseCause: 'task_contract_violation',
        runId: RUN_ID,
        taskId: TASK_ID,
        taskDef: null,
        resumePrompt: 'b'.repeat(1500),
        replaceOutputSchema: { type: 'object', properties: {} },
      });
      const parsed = WorkflowResumeContractSchema.safeParse(contract);
      expect(parsed.success).toBe(true);
      expect((contract.pausedTaskInputContract?.prompt ?? '').length).toBeLessThanOrEqual(2000);
      expect(contract.resumePrompt.length).toBe(1500);
    });

    it('transient_error round-trips with both safe and unsafe task definitions', () => {
      for (const retryability of ['safe', 'unsafe', 'unknown'] as const) {
        const contract = buildResumeContract({
          pauseCause: 'transient_error',
          runId: RUN_ID,
          taskId: TASK_ID,
          taskDef: {
            taskId: TASK_ID,
            name: 'External call',
            goal: 'g',
            type: 'agent',
            retryability,
            maxAttempts: 3,
          } as never,
          errorMessage: 'c'.repeat(800),
          pausedTaskAttempt: PAUSED_ATTEMPT,
        });
        const parsed = WorkflowResumeContractSchema.safeParse(contract);
        expect(parsed.success).toBe(true);
        expect((contract.pausedTaskInputContract?.prompt ?? '').length).toBeLessThanOrEqual(2000);
      }
    });
  });

  describe('Plan 171 guardrail — every non-HITL pause cause is reachable', () => {
    it('handles every WorkflowRunPauseReason except needs_decision (HITL)', () => {
      const allCauses = new Set(WorkflowRunPauseReasonSchema.options);
      // needs_decision is owned by the HITL hydration path at
      // dispatch.ts:984; it has its own builder because action-preview
      // resolution requires upstream task outputs.
      allCauses.delete('needs_decision');
      expect([...allCauses].sort()).toEqual([...BUILD_RESUME_CONTRACT_HANDLED_CAUSES].sort());
    });
  });
});
