/**
 * The approval records in memory, keyed as Redis keys them: grants by run and
 * request hash, written here only by `decide` — the test's stand-in for the
 * operator's authenticated resolve — and the host's own records beside them.
 */
import type { WriteApprovalGrant } from '@aflow/schemas';

import type { ApprovalStore } from '../../browser/actionApproval.js';
import type { PageOwner } from '../../browser/pageTable.js';

export interface MemoryApprovals extends ApprovalStore {
  /** The operator's decision on a request, as the resolve boundary records it. */
  decide(
    scope: PageOwner,
    requestHash: string,
    decision: WriteApprovalGrant['decision'],
    reason?: string,
  ): void;
  readonly grants: Map<string, WriteApprovalGrant>;
  readonly spent: Set<string>;
}

function scoped(scope: PageOwner, key: string): string {
  return `${scope.tenantId}:${scope.runId}:${key}`;
}

export function memoryApprovals(): MemoryApprovals {
  const grants = new Map<string, WriteApprovalGrant>();
  const asks = new Map<string, string>();
  const spent = new Set<string>();
  let decisions = 0;
  return {
    grants,
    spent,
    decide(scope, requestHash, decision, reason) {
      decisions += 1;
      grants.set(scoped(scope, requestHash), {
        requestHash,
        decision,
        approvedBy: 'operator',
        decidedAt: new Date(Date.UTC(2026, 9, 4, 12, 0, decisions)).toISOString(),
        ...(reason !== undefined ? { reason } : {}),
      });
    },
    grant: (scope, requestHash) => Promise.resolve(grants.get(scoped(scope, requestHash)) ?? null),
    spend: (scope, grant) => {
      const key = scoped(scope, `${grant.requestHash}@${grant.decidedAt ?? ''}`);
      if (spent.has(key)) return Promise.resolve(false);
      spent.add(key);
      return Promise.resolve(true);
    },
    recall: (scope, callKey) => Promise.resolve(asks.get(scoped(scope, callKey)) ?? null),
    remember: (scope, callKey, requestHash) => {
      asks.set(scoped(scope, callKey), requestHash);
      return Promise.resolve();
    },
  };
}
