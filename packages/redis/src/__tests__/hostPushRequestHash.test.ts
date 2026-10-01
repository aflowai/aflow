import { describe, expect, it } from 'vitest';

import { hostPushRequestHash } from '../writeApproval.js';

const PUSH = {
  bindingId: 'folder-1',
  refspec: `${'c'.repeat(40)}:refs/heads/aflow/x`,
  receipt: 'receipt-of-the-scan',
};

describe('the request hash a host push is approved under', () => {
  it('is the same for the same push, whatever else rides with it or in what order', () => {
    const reordered = { receipt: PUSH.receipt, refspec: PUSH.refspec, bindingId: PUSH.bindingId };
    expect(hostPushRequestHash(reordered)).toBe(hostPushRequestHash(PUSH));
    const withPreview = { ...PUSH, commitMessage: 'shown to the operator' };
    expect(hostPushRequestHash(withPreview)).toBe(hostPushRequestHash(PUSH));
  });

  it('differs when the folder, the refspec or the receipt does', () => {
    for (const changed of [
      { ...PUSH, bindingId: 'folder-2' },
      { ...PUSH, refspec: `${'c'.repeat(40)}:refs/heads/aflow/y` },
      { ...PUSH, receipt: 'receipt-of-another-scan' },
    ]) {
      expect(hostPushRequestHash(changed)).not.toBe(hostPushRequestHash(PUSH));
    }
  });
});
