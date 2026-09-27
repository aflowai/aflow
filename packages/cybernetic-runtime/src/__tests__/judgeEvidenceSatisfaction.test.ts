import { describe, it, expect } from 'vitest';
import type { JudgeEvidenceSelector } from '@aflow/schemas';

import { checkEvidenceSatisfaction } from '../judgeEvidenceSatisfaction.js';
import type { JudgeEvidence } from '../judgeCall.js';

const pack = (over: Partial<JudgeEvidence> = {}): JudgeEvidence => ({
  taskSummaries: [{ taskId: 'answer-the-customer', status: 'paused' }],
  ...over,
});

const reads = (...selectors: JudgeEvidenceSelector[]): JudgeEvidenceSelector[] => selectors;

describe('a criterion is only asked what the pack can answer', () => {
  it('is satisfied when the pack holds what was declared', () => {
    const result = checkEvidenceSatisfaction(
      pack({
        reply: 'Your refund is with the merchant.',
        toolResults: [{ sequence: 1, endpointId: 'order_inspect', status: 200, body: '{}' }],
      }),
      reads({ kind: 'reply' }, { kind: 'tool_result', endpointId: 'order_inspect' }),
    );
    expect(result).toEqual({ satisfied: true, missing: [] });
  });

  it('refuses when the reply the criterion reads is absent', () => {
    // The exact failure this exists for: a judge given tool JSON and no reply
    // concludes no answer was produced and scores against evidence it was
    // never shown.
    const result = checkEvidenceSatisfaction(pack(), reads({ kind: 'reply' }));
    expect(result.satisfied).toBe(false);
    expect(result.missing[0]).toContain('reply');
  });

  it('treats an empty reply as absent, not as a short one', () => {
    const result = checkEvidenceSatisfaction(pack({ reply: '   ' }), reads({ kind: 'reply' }));
    expect(result.satisfied).toBe(false);
  });

  it('refuses when the named endpoint is not in the pack', () => {
    // Asked whether a stated reference was real, with nothing from the tool
    // that would have returned it, a judge reads the fact as fabricated.
    const result = checkEvidenceSatisfaction(
      pack({
        toolResults: [{ sequence: 1, endpointId: 'payments_search', status: 200, body: '{}' }],
      }),
      reads({ kind: 'tool_result', endpointId: 'order_inspect' }),
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing[0]).toContain('order_inspect');
  });

  it('names every missing part, not just the first', () => {
    const result = checkEvidenceSatisfaction(
      pack(),
      reads({ kind: 'reply' }, { kind: 'tool_result', endpointId: 'order_inspect' }),
    );
    expect(result.missing).toHaveLength(2);
  });

  it('does not crash on a criterion that never went through the schema', () => {
    // `reads` defaults to [] on parse, so an unparsed criterion carries
    // undefined while the type says otherwise. Crashing here would cost the
    // whole trial's grading over a missing declaration.
    expect(checkEvidenceSatisfaction(pack(), undefined).satisfied).toBe(true);
  });

  it('is satisfied by a criterion that declares nothing', () => {
    // Declaring nothing is how a judge ends up guessing, but it is not this
    // check's job to forbid it — an empty declaration reads whatever is there.
    expect(checkEvidenceSatisfaction(pack(), []).satisfied).toBe(true);
  });

  it('checks the task summaries a run did or did not produce', () => {
    expect(checkEvidenceSatisfaction(pack(), reads({ kind: 'task_summary' })).satisfied).toBe(true);
    expect(
      checkEvidenceSatisfaction({ taskSummaries: [] }, reads({ kind: 'task_summary' })).satisfied,
    ).toBe(false);
  });
});
