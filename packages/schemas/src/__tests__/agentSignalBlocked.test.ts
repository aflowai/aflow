import { describe, it, expect } from 'vitest';
import { AgentSignalBlockedInputSchema } from '../operations/agentControl.js';

describe('AgentSignalBlockedInputSchema — Plan 117 Phase 1 categories', () => {
  it('accepts category=capability_unavailable', () => {
    const parsed = AgentSignalBlockedInputSchema.parse({
      reason: 'kaggle-rest-api binding is required by the goal but not enabled',
      category: 'capability_unavailable',
    });
    expect(parsed.category).toBe('capability_unavailable');
  });

  it('accepts category=data_unavailable', () => {
    const parsed = AgentSignalBlockedInputSchema.parse({
      reason: 'cannot reach the real data source declared in provenance contract',
      category: 'data_unavailable',
      needed: 'enable the kaggle binding or upload the dataset',
    });
    expect(parsed.category).toBe('data_unavailable');
  });

  it('still accepts the existing categories', () => {
    for (const category of [
      'missing_input',
      'ambiguous_requirement',
      'approval_required',
      'external_dependency',
      'access_denied',
      'other',
    ] as const) {
      expect(() => AgentSignalBlockedInputSchema.parse({ reason: 'x', category })).not.toThrow();
    }
  });

  it('rejects an unrelated category', () => {
    expect(() =>
      AgentSignalBlockedInputSchema.parse({ reason: 'x', category: 'made_up' }),
    ).toThrow();
  });
});
