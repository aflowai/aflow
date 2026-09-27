import type { Redis } from 'ioredis';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  TraceId,
  AgentDefinition,
  StepDefinition,
} from '@aflow/schemas';
import type { CheckResult } from '../../GuardrailGate/index.js';
import type { SessionHotState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { waitForInput as stepServiceWaitForInput } from '../../StepService/index.js';
import type { RequiredVariable } from '../../StepService/index.js';
import { parseOverlay, serializeOverlay } from '../helpers/runtimeState.js';
import { agentChatInputVarId } from '../helpers/inputPause.js';

export interface GuardrailEscalationPauseArgs {
  redis: Redis;
  payloadStore: PayloadStore;
  result: {
    tenantId: string;
    sessionId: string;
    stepId: string;
    stepExecutionId: string;
    attempt: number;
    traceId: string;
    outputRef?: string | null | undefined;
  };
  gr: CheckResult;
  agentDef: AgentDefinition;
  stepDef: StepDefinition;
  runHotState: SessionHotState;
  currentRuntimeState: NonNullable<SessionHotState['runtimeState']>;
  now: number;
}

/** Park the session for human review of a guardrail escalation. The caller's
 *  post-`handled` sweep in applyResult routes the pause to its subscriber. */
export async function pauseForGuardrailEscalation(
  args: GuardrailEscalationPauseArgs,
): Promise<void> {
  const { redis, payloadStore, result, gr, agentDef, stepDef, runHotState, now } = args;

  const violationMessages = gr.violations
    .map((v) => v.message ?? `${v.type}: ${v.railId}`)
    .join('; ');
  const escalationPrompt =
    gr.action === 'retry'
      ? `The agent exceeded the guardrail retry limit. Violations: ${violationMessages}. ` +
        `Please review and provide guidance.`
      : `Guardrail escalation: ${violationMessages}. Human review required.`;

  const overlay = parseOverlay({});
  const chatVarId = agentChatInputVarId(result.stepId);
  if (!overlay[chatVarId]) {
    overlay[chatVarId] = {
      variableId: chatVarId,
      name: 'Message',
      description: 'Provide guidance to the agent after guardrail escalation',
      typeSchema: { type: 'string' },
      semanticType: 'text',
      lifecycle: { isInput: true, isOutput: false },
      required: true,
    };
  }

  const requiredVars: RequiredVariable[] = [
    {
      variableId: chatVarId,
      name: 'Message',
      description: 'Provide guidance to the agent after guardrail escalation',
      required: true,
    },
  ];

  await stepServiceWaitForInput(
    { redis, payloadStore },
    {
      tenantId: result.tenantId as TenantId,
      runId: result.sessionId as SessionId,
      agentDef,
      traceId: result.traceId as TraceId,
      stepDef,
      stepExecutionId: result.stepExecutionId as StepExecutionId,
      attempt: result.attempt,
      runState: runHotState,
    },
    requiredVars,
    {
      prompt: escalationPrompt,
      stepStateUpdates: {
        status: 'PAUSED' as const,
        endedAt: now,
        ...(result.outputRef ? { outputRef: result.outputRef } : {}),
      },
      runStateUpdates: {
        variableDefsOverlay: serializeOverlay(overlay),
      },
      runtimeState: args.currentRuntimeState,
      pauseType: 'guardrail_escalation',
    },
  );
}
