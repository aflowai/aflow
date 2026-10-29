/**
 * Whether a workflow run's grant covers a harness browser, judged when a
 * skill's read of a connected folder is dispatched (Plan 320 D20). Commission
 * Change and Review Local Changes add the browser to their harness run by rule;
 * the rule asks this first, so a space whose grant withholds `browser.page:write`
 * runs without one and says so, rather than being refused the run.
 */
import { buildOperationId, type TenantId } from '@aflow/schemas';

import { harnessBrowserGrant } from '../../gates/decideStepGating.js';
import { establishRunAccessGrant } from '../../SessionOrchestrator/helpers/workflowGrantGate.js';
import type { HarnessDeps } from './types.js';

const HOST_BINDING_INSPECT_OPERATION = buildOperationId('host', 'binding', 'inspect');

/**
 * The judgement a `host.binding.inspect` job carries; undefined for any other
 * operation, and for a run started with no authority to judge, which no gate
 * holds to a grant either.
 */
export async function browserGrantFor(
  deps: Pick<HarnessDeps, 'db' | 'redis'>,
  tenantId: TenantId,
  anchorSessionId: string | undefined,
  operationId: string,
): Promise<boolean | undefined> {
  if (operationId !== HOST_BINDING_INSPECT_OPERATION || anchorSessionId === undefined) {
    return undefined;
  }
  // Every read of a folder is dispatched through here, the publication's
  // included: a grant that cannot be read withholds the browser, never the read.
  const established = await establishRunAccessGrant({
    db: deps.db,
    redis: deps.redis,
    tenantId,
    sessionId: anchorSessionId,
  }).catch(() => ({ kind: 'authority_unavailable' as const }));
  if (established.kind === 'ungoverned') return undefined;
  if (established.kind !== 'granted') return false;
  return harnessBrowserGrant(established.grant, 'op_task').allowed;
}
