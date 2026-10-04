import type { Redis } from 'ioredis';
import {
  getWriteApprovalGrant,
  readBrowserAsk,
  rememberBrowserAsk,
  spendBrowserApproval,
} from '@aflow/redis';

import type { ApprovalStore } from './actionApproval.js';

/** Approvals as the stack keeps them: the write-approval grant, read only, and the host's own records beside it. */
export function redisApprovalStore(redis: Redis): ApprovalStore {
  return {
    grant: async (scope, requestHash) =>
      await getWriteApprovalGrant(redis, scope.tenantId, scope.runId, requestHash),
    spend: async (scope, grant) =>
      await spendBrowserApproval(redis, scope.tenantId, scope.runId, grant),
    recall: async (scope, callKey) =>
      await readBrowserAsk(redis, scope.tenantId, scope.runId, callKey),
    remember: async (scope, callKey, requestHash) => {
      await rememberBrowserAsk(redis, scope.tenantId, scope.runId, callKey, requestHash);
    },
  };
}
