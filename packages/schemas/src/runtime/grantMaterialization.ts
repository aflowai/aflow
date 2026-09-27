import { getOperation } from '../catalog/registry.js';
import {
  enforceGrant,
  type CallerContext,
  type GrantEnforcementResult,
  type RunAccessGrant,
} from './runAccessGrant.js';

/**
 * `enforceGrant`'s answer for an agent invoking this operation, and the boolean
 * projection of it. Pure — used at tool materialization so ops the grant would
 * deny are never offered to the model instead of burning turns collecting
 * denials, and by callers that must say *why* rather than only whether: a
 * refusal blamed on the wrong cause sends an operator to a setting that cannot
 * fix it.
 *
 * A null grant never hides tools: enforcement at step scheduling still pauses
 * fail-closed, and an empty surface would mask the pause path that restores
 * the missing grant.
 */
export function grantDecisionForOperation(
  grant: RunAccessGrant | null,
  operationId: string,
  caller: CallerContext = { kind: 'agent' },
): GrantEnforcementResult {
  if (!grant) return { allowed: true };
  const op = getOperation(operationId);
  if (op?.bypassGrant) return { allowed: true };
  const opMutates = op?.mutates ?? false;
  return enforceGrant(
    grant,
    operationId,
    opMutates,
    op?.privileged ?? false,
    op?.capabilityGroupId ?? operationId.split('.').slice(0, -1).join('.'),
    op?.accessMode ?? (opMutates ? 'write' : 'read'),
    op?.riskModifiers ?? [],
    { opTaskOnly: op?.opTaskOnly ?? false },
    caller,
  );
}

export function wouldGrantAllowOperation(
  grant: RunAccessGrant | null,
  operationId: string,
): boolean {
  return grantDecisionForOperation(grant, operationId).allowed;
}
