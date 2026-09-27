import { describe, expect, it } from 'vitest';
import { buildCallSignature } from '../applyAgentDecision.js';

/**
 * The loop detector pauses a run after the same call repeats 5 times. It reads
 * the decision, so it does not care whether the tool succeeds — which is what
 * makes it the right guard for a tool that always succeeds.
 *
 * It was defeated by an argument required to be unique: a Runner sent the
 * identical draft_patch 130 times, each with a fresh mutationId, and every one
 * counted as a first occurrence.
 */
const SHAPE_OPS = [{ op: 'add', path: '', value: { cases: [], rationale: '' } }];

describe('loop signature ignores replay keys', () => {
  it('sees one repeated call where the run sent 130', () => {
    const signatures = Array.from({ length: 130 }, (_, i) =>
      buildCallSignature([
        {
          toolId: 'draft_patch',
          args: { mutationId: `shape-${String(i + 1)}`, operations: SHAPE_OPS },
        },
      ]),
    );
    expect(new Set(signatures).size).toBe(1);
  });

  it('still separates calls that differ in what they actually do', () => {
    const shape = buildCallSignature([
      { toolId: 'draft_patch', args: { mutationId: 'a', operations: SHAPE_OPS } },
    ]);
    const append = buildCallSignature([
      {
        toolId: 'draft_patch',
        args: {
          mutationId: 'b',
          operations: [{ op: 'add', path: '/cases/-', value: { title: 'x' } }],
        },
      },
    ]);
    expect(shape).not.toBe(append);
  });

  it('separates the same arguments sent to different tools', () => {
    const a = buildCallSignature([{ toolId: 'draft_patch', args: { mutationId: 'm' } }]);
    const b = buildCallSignature([{ toolId: 'draft_get', args: { mutationId: 'm' } }]);
    expect(a).not.toBe(b);
  });

  it('is order-independent across parallel calls in one turn', () => {
    const one = buildCallSignature([
      { toolId: 'draft_get', args: {} },
      { toolId: 'draft_get', args: {} },
    ]);
    const two = buildCallSignature([
      { toolId: 'draft_get', args: {} },
      { toolId: 'draft_get', args: {} },
    ]);
    expect(one).toBe(two);
  });

  it('does not treat a missing args object as different from an empty one', () => {
    expect(buildCallSignature([{ toolId: 't' }])).toBe(
      buildCallSignature([{ toolId: 't', args: {} }]),
    );
  });
});
