import { describe, it, expect } from 'vitest';
import { getAllOperations } from '../registry.js';

describe('operation follow-ups', () => {
  it('never recommend an operation that carries its own alternative', () => {
    // An `agentAlternative` says "reach this another way". A follow-up naming
    // that operation is the platform recommending the path it then refuses.
    const operations = getAllOperations();
    const offenders: string[] = [];
    for (const [operationId, op] of operations) {
      for (const followUp of op.usage.followUp ?? []) {
        if (operations.get(followUp.operationId)?.agentAlternative) {
          offenders.push(`${operationId} → ${followUp.operationId}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
