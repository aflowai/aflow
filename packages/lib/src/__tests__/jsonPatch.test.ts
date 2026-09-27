import { describe, expect, it } from 'vitest';
import { applyJsonPatch, JsonPatchError } from '../jsonPatch.js';

describe('a failed op reports the failure, not the document', () => {
  const bigDocument = {
    state: {
      shots: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `sh_${String(index)}`,
          { prompt: 'x'.repeat(400) },
        ]),
      ),
    },
  };

  function refusalOf(op: Parameters<typeof applyJsonPatch>[1][number]): JsonPatchError {
    try {
      applyJsonPatch(bigDocument, [op]);
    } catch (error) {
      return error as JsonPatchError;
    }
    throw new Error('the patch applied instead of failing');
  }

  it('drops the document fast-json-patch serializes into its message', () => {
    const refused = refusalOf({ op: 'test', path: '/state/shots/sh_0/prompt', value: 'nope' });

    expect(refused).toBeInstanceOf(JsonPatchError);
    expect(refused.message).toContain('TEST_OPERATION_FAILED');
    // A refusal carrying the whole document is a refusal an agent cannot read:
    // one failed applet action would spend its turn on state it already held.
    expect(refused.message).not.toContain('tree:');
    expect(refused.message.length).toBeLessThan(600);
  });

  it('keeps the index and path, which are what name the failure', () => {
    const refused = refusalOf({ op: 'test', path: '/state/shots/sh_0/prompt', value: 'nope' });

    expect(refused.opPath).toBe('/state/shots/sh_0/prompt');
    expect(refused.opIndex).toBe(0);
  });

  it('reports an unresolvable path without the document either', () => {
    const refused = refusalOf({ op: 'replace', path: '/state/shots/sh_nope/prompt', value: 'x' });

    expect(refused.message).not.toContain('tree:');
    expect(refused.message.length).toBeLessThan(600);
  });
});
