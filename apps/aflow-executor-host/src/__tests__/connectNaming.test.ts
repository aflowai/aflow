/**
 * What the machine tells the workspace about the names it already uses.
 *
 * The workspace decides the folder's name from this list, so an entry that
 * misreports a folder or a workspace is how a name ends up recorded for one
 * space while the machine answers for another.
 */
import { describe, expect, it } from 'vitest';

import { HostBindingSchema, type HostBinding } from '../bindings.js';
import { namesInUseFor } from '../connectNaming.js';

function binding(fields: Partial<HostBinding> & { id: string; root: string }): HostBinding {
  return HostBindingSchema.parse({ mode: 'read', ...fields });
}

describe('the names a machine reports as taken', () => {
  it('names each binding with its folder and its workspace', () => {
    expect(
      namesInUseFor([
        binding({ id: 'hb_docs', root: '/Users/someone/docs', spaceId: 'space-a' }),
        binding({ id: 'hb_code', root: '/Users/someone/code', spaceId: 'space-b' }),
      ]),
    ).toEqual([
      { hostBindingId: 'hb_docs', root: '/Users/someone/docs', spaceId: 'space-a' },
      { hostBindingId: 'hb_code', root: '/Users/someone/code', spaceId: 'space-b' },
    ]);
  });

  it('claims no workspace for a binding that records none', () => {
    // Such a binding is refused at use however right it looks, so it cannot hold
    // a name on a workspace's behalf — and reporting it as one would rename a
    // folder to avoid a claim nothing can exercise.
    expect(namesInUseFor([binding({ id: 'hb_old', root: '/Users/someone/old' })])).toEqual([
      { hostBindingId: 'hb_old', root: '/Users/someone/old' },
    ]);
  });

  it('says nothing when the machine offers nothing', () => {
    expect(namesInUseFor([])).toEqual([]);
  });
});
