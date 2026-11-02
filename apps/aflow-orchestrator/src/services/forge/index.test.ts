/**
 * The event source's provider selection (Plan 340 D1): one selection, by the
 * host of a change request's address, gives the reader that parses the
 * forge's answers and the conditional GET that carries them.
 *
 * The case that must fail if parse and transport are chosen apart: a change
 * request on a host GitHub does not answer for handed GitHub's reader or
 * GitHub's GET.
 */
import { describe, expect, it, vi } from 'vitest';
import { GITHUB_EVENT_READER } from './github/pullRequestReads.js';
import { forgeEventProviderFor, forgeEventReaderFor, type ForgeConditionalGets } from './index.js';

function gets() {
  const github = vi.fn<ForgeConditionalGets['github']>(async () => ({
    status: 304,
    etag: null,
    body: null,
  }));
  return { github };
}

describe('forgeEventProviderFor', () => {
  it("gives a change request on github.com GitHub's reader and GitHub's GET", () => {
    const all = gets();
    const provider = forgeEventProviderFor(all, 'https://github.com/aflowai/aflow/pull/276');
    expect(provider.reader).toBe(GITHUB_EVENT_READER);
    expect(provider.get).toBe(all.github);
  });

  it('names the provider from the host in any case', () => {
    const all = gets();
    const provider = forgeEventProviderFor(all, 'https://GitHub.com/aflowai/aflow/pull/276');
    expect(provider.get).toBe(all.github);
  });

  it("gives the default host's provider where the watch has no address", () => {
    const all = gets();
    const provider = forgeEventProviderFor(all);
    expect(provider.reader).toBe(GITHUB_EVENT_READER);
    expect(provider.get).toBe(all.github);
  });

  it("hands a host GitHub does not answer for neither GitHub's reader nor its GET", () => {
    const all = gets();
    expect(() =>
      forgeEventProviderFor(all, 'https://gitlab.com/aflowai/aflow/-/merge_requests/276'),
    ).toThrow(/gitlab\.com/);
    expect(() =>
      forgeEventReaderFor('https://gitlab.com/aflowai/aflow/-/merge_requests/276'),
    ).toThrow(/gitlab\.com/);
    expect(all.github).not.toHaveBeenCalled();
  });
});
