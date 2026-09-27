import { describe, expect, it } from 'vitest';
import { REDACTED, redactAuditDetails } from './auditRedaction.js';

/**
 * An audit row is the one record designed to be retained, exported and read by
 * people who were not present, so a secret reaching it is retained on purpose.
 */
describe('redactAuditDetails', () => {
  it('drops values whose key names a secret, in any of the spellings used in the wild', () => {
    const out = redactAuditDetails({
      apiKey: 'sk-live-1',
      api_key: 'sk-live-2',
      'X-Api-Key': 'sk-live-3',
      clientSecret: 'cs-1',
      password: 'hunter2',
      authorization: 'Bearer abc',
      credentialKey: 'ck-1',
      refreshToken: 'rt-1',
    })!;
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toMatch(/sk-live|hunter2|Bearer abc|cs-1|ck-1|rt-1/);
  });

  it('keeps the diagnostic part of a signed URL and drops the part that authorizes', () => {
    const out = redactAuditDetails({
      url: 'https://storage.googleapis.com/b/o.json?X-Goog-Signature=deadbeef&exp=1',
    })!;
    expect(out['url']).toBe(`https://storage.googleapis.com/b/o.json?${REDACTED}`);
    expect(String(out['url'])).not.toContain('deadbeef');
  });

  it('redacts nested and array-held secrets, not just top-level ones', () => {
    const out = redactAuditDetails({
      request: { headers: { authorization: 'Bearer x' }, ok: true },
      items: [{ token: 't1' }, { token: 't2' }],
    })!;
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('Bearer x');
    expect(flat).not.toContain('t1');
    expect(flat).not.toContain('t2');
    // The surrounding structure survives — redaction is not deletion.
    expect(flat).toContain('"ok":true');
  });

  it('keeps ordinary evidence intact, so the record stays useful', () => {
    const out = redactAuditDetails({ spaceId: 'sp-1', count: 3, ok: false, note: 'denied' })!;
    expect(out).toEqual({ spaceId: 'sp-1', count: 3, ok: false, note: 'denied' });
  });

  it('bounds a value that is a payload rather than a description of one', () => {
    const out = redactAuditDetails({ blob: 'x'.repeat(9000) })!;
    expect(String(out['blob']).length).toBeLessThan(2200);
    expect(String(out['blob'])).toContain('truncated');
  });

  it('terminates on a self-referential bag instead of walking forever', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    expect(() => redactAuditDetails(cyclic)).not.toThrow();
  });

  it('passes undefined through, so an event without details stays without details', () => {
    expect(redactAuditDetails(undefined)).toBeUndefined();
  });
});
