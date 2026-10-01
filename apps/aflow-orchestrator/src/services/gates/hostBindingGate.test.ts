/**
 * Contract: every host operation whose input names a binding is one the
 * workspace's half of the binding is checked for. A host operation left off
 * the list reaches any folder its machine offers, whether or not this
 * workspace still has it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getAllOperations } from '@aflow/schemas';

import { HOST_BINDING_GATED_OPERATIONS } from './hostBindingGate.js';

function takesABinding(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodEffects) return takesABinding(schema.innerType());
  return schema instanceof z.ZodObject && 'bindingId' in schema.shape;
}

describe('the host binding gate', () => {
  it('covers every host operation that takes a bindingId', () => {
    const takingABinding = [...getAllOperations().values()]
      .filter((op) => op.operationId.startsWith('host.'))
      .filter((op) => takesABinding(op.inputZod as z.ZodTypeAny))
      .map((op) => op.operationId)
      .sort();

    expect(takingABinding).toContain('host.binding.inspect');
    expect([...HOST_BINDING_GATED_OPERATIONS].sort()).toEqual(takingABinding);
  });
});
