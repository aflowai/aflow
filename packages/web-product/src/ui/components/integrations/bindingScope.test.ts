import { describe, it, expect } from 'vitest';

import { preservedBindingScope } from './bindingScope.js';

describe('preservedBindingScope', () => {
  it('carries a stored flow scope through an edit', () => {
    expect(preservedBindingScope({ scope: { flowId: 'flow-7' } })).toEqual({ flowId: 'flow-7' });
  });

  it('sends nothing for a space-wide binding', () => {
    expect(preservedBindingScope({ scope: {} })).toEqual({});
  });

  it('sends nothing when there is no binding to edit', () => {
    expect(preservedBindingScope()).toEqual({});
    expect(preservedBindingScope({})).toEqual({});
  });

  it('never forwards the tenant or space the server composes', () => {
    const stored = { scope: { tenantId: 't-1', spaceId: 's-1', flowId: 'flow-7' } };
    expect(preservedBindingScope(stored)).toEqual({ flowId: 'flow-7' });
  });

  it('treats a non-string or empty flowId as absent rather than sending it', () => {
    expect(preservedBindingScope({ scope: { flowId: '' } })).toEqual({});
    expect(preservedBindingScope({ scope: { flowId: 42 } })).toEqual({});
    expect(preservedBindingScope({ scope: { flowId: null } })).toEqual({});
  });
});
