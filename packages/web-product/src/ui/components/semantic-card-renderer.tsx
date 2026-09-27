'use client';

/**
 * Shared semantic type detection and card rendering.
 *
 * Used by both content-renderer (chat) and DocumentPane (memory explorer)
 * to render structured data with specialized card components.
 */

import { detectGuardrailContent } from './guardrail/detectGuardrailContent.js';
import { GuardrailPolicyCard } from './guardrail/GuardrailPolicyCard.js';
import { GuardrailPolicyListCard } from './guardrail/GuardrailPolicyListCard.js';
import { GuardrailViolationsCard } from './guardrail/GuardrailViolationsCard.js';
import { ComputeResultCard, isComputeResult } from './compute/ComputeResultCard.js';
import {
  HostInspectCard,
  HostProcessCard,
  isHostHarnessResult,
  isHostInspectResult,
  isHostProcessResult,
} from './host/HostOutputCard.js';
import { HarnessStepCard } from './harness-activity-card.js';
import { WorkflowRunStatusCard, isWorkflowRunStatus } from './workflow/WorkflowRunStatusCard.js';
import { WorkflowEvaluationCard, isWorkflowEvaluation } from './workflow/WorkflowEvaluationCard.js';
import { WorkflowLedgerCard, isWorkflowLedger } from './workflow/WorkflowLedgerCard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectedSemanticType =
  | 'guardrail_policy'
  | 'guardrail_policy_list'
  | 'guardrail_violations'
  | 'compute_result'
  | 'host_process'
  | 'host_inspect'
  | 'host_harness'
  | 'workflow_run_status'
  | 'workflow_evaluation'
  | 'workflow_ledger'
  | null;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect semantic type from JSON data shape.
 * Combines guardrail, compute, and workflow type guards.
 */
export function detectSemanticType(data: unknown): DetectedSemanticType {
  if (!data || typeof data !== 'object') return null;

  const guardrailType = detectGuardrailContent(data);
  if (guardrailType) return guardrailType;

  // Before compute: a host result also carries `exitCode` and `durationMs`, and
  // is distinguished by its handle rather than by the fields it shares.
  if (isHostProcessResult(data)) return 'host_process';
  // After exec: an exec result also carries a handle, and only inspect carries
  // a state, so the narrower shape is tested once the wider one has declined.
  if (isHostInspectResult(data)) return 'host_inspect';
  if (isHostHarnessResult(data)) return 'host_harness';
  if (isComputeResult(data)) return 'compute_result';
  if (isWorkflowRunStatus(data)) return 'workflow_run_status';
  if (isWorkflowEvaluation(data)) return 'workflow_evaluation';
  if (isWorkflowLedger(data)) return 'workflow_ledger';

  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a specialized card for a given semantic type. Returns null if unknown type. */
export function renderSemanticCard(
  semanticType: string,
  data: unknown,
  context: { stepExecutionId?: string | undefined } = {},
): React.ReactNode | null {
  switch (semanticType) {
    case 'guardrail_policy':
      return <GuardrailPolicyCard data={data} />;
    case 'guardrail_policy_list':
      return <GuardrailPolicyListCard data={data} />;
    case 'guardrail_violations':
      return <GuardrailViolationsCard data={data} />;
    case 'compute_result':
      return <ComputeResultCard data={data} />;
    case 'host_process':
      return isHostProcessResult(data) ? <HostProcessCard result={data} /> : null;
    case 'host_inspect':
      return isHostInspectResult(data) ? <HostInspectCard result={data} /> : null;
    case 'host_harness':
      // The same card the step row shows: the result, with the run's activity
      // folded above it rather than discarded once the step ended.
      return isHostHarnessResult(data) ? (
        <HarnessStepCard stepExecutionId={context.stepExecutionId} running={false} result={data} />
      ) : null;
    case 'workflow_run_status':
      return <WorkflowRunStatusCard data={data} />;
    case 'workflow_evaluation':
      return <WorkflowEvaluationCard data={data} />;
    case 'workflow_ledger':
      return <WorkflowLedgerCard data={data} />;
    default:
      return null;
  }
}

/** Human-readable label for a semantic type (used in toggle tooltips). */
export function semanticTypeLabel(st: string): string {
  switch (st) {
    case 'guardrail_policy':
      return 'Guardrail Policy';
    case 'guardrail_policy_list':
      return 'Guardrail Policies';
    case 'guardrail_violations':
      return 'Guardrail Violations';
    case 'compute_result':
      return 'Compute Result';
    case 'host_process':
      return 'Command on your computer';
    case 'host_inspect':
      return 'Still running on your computer';
    case 'host_harness':
      return 'Coding agent';
    case 'workflow_run_status':
      return 'Workflow Run Status';
    case 'workflow_evaluation':
      return 'Workflow Evaluation';
    case 'workflow_ledger':
      return 'Workflow Ledger';
    default:
      return st;
  }
}
