import { describe, expect, it } from 'vitest';

import { fetchCredential, scrubSecret } from '../credentialFetch.js';
import { HarnessProfileSchema, readCredentialFromOutput } from '../harnessProfiles.js';

const bare = HarnessProfileSchema.parse({ id: 'bare', executable: 'claude' });

function withCredential(overrides: Record<string, unknown> = {}) {
  return HarnessProfileSchema.parse({
    id: 'claude',
    executable: 'claude',
    credential: { command: ['printf', 'tok\n'], env: 'TOKEN', ...overrides },
  });
}

describe('credential source', () => {
  it('fetches nothing for a profile that declares no source', async () => {
    expect(await fetchCredential(bare)).toBeUndefined();
  });

  it('takes a bare token as the whole output, trimmed', async () => {
    expect(await fetchCredential(withCredential())).toBe('tok');
  });

  it('takes a nested field when the store prints JSON', () => {
    const value = readCredentialFromOutput(
      withCredential({ jsonPath: 'a.b.token' }),
      '{"a":{"b":{"token":"sk-x"}}}',
    );
    expect(value).toBe('sk-x');
  });

  it('fails loudly on a path that is not there, rather than passing nothing on', () => {
    expect(() =>
      readCredentialFromOutput(withCredential({ jsonPath: 'a.missing' }), '{"a":{}}'),
    ).toThrow(/no string at 'a.missing'/);
  });

  it('fails when a jsonPath was configured but the output is not JSON', () => {
    expect(() => readCredentialFromOutput(withCredential({ jsonPath: 'a' }), 'plain')).toThrow(
      /did not print JSON/,
    );
  });

  it('refuses an empty credential instead of handing the harness an empty string', () => {
    expect(() => readCredentialFromOutput(withCredential(), '   \n')).toThrow(/produced nothing/);
  });

  it('reports a failing command without quoting the command or its streams', async () => {
    // Node builds an execFile error message out of the command line and the
    // process's stderr. Either can carry a credential, so neither is repeated.
    const profile = withCredential({
      command: ['sh', '-c', 'echo sk-on-stdout; echo sk-on-stderr >&2; exit 3'],
    });
    await expect(fetchCredential(profile)).rejects.toThrow(/exit 3/);
    await expect(fetchCredential(profile)).rejects.not.toThrow(/sk-on-stdout/);
    await expect(fetchCredential(profile)).rejects.not.toThrow(/sk-on-stderr/);
  });
});

describe('scrubbing', () => {
  it('removes every occurrence of the credential', () => {
    expect(scrubSecret('a sk-abc12345 b sk-abc12345', 'sk-abc12345')).toBe(
      'a [redacted] b [redacted]',
    );
  });

  it('leaves text alone when there is no credential', () => {
    expect(scrubSecret('nothing to hide', undefined)).toBe('nothing to hide');
  });

  it('will not redact a short value, which would blank out ordinary text', () => {
    expect(scrubSecret('the cat sat', 'cat')).toBe('the cat sat');
  });
});
