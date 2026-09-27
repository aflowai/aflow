import { describe, expect, it } from 'vitest';

import { mapDefinitionRow, resolveIntegrationIcon } from './shared.js';

/**
 * The precedence in `resolveIntegrationIcon` is the whole design: a curated
 * default that a definition can override. Both halves matter — lose the default
 * and every installed connector goes back to a generic tile; lose the override
 * and a hand-authored integration can never have artwork at all.
 */
describe('resolveIntegrationIcon', () => {
  it('prefers an icon declared on the definition over the curated default', () => {
    expect(
      resolveIntegrationIcon('github', { icon: { kind: 'phosphor', name: 'wrench' } }),
    ).toEqual({ kind: 'phosphor', name: 'wrench' });
  });

  it('falls back to the curated default for a well-known id', () => {
    expect(resolveIntegrationIcon('github', {})).toEqual({ kind: 'brand', assetId: 'github' });
  });

  it('gives a hand-authored integration its own declared icon', () => {
    expect(
      resolveIntegrationIcon('my-internal-api', { icon: { kind: 'brand', assetId: 'slack' } }),
    ).toEqual({ kind: 'brand', assetId: 'slack' });
  });

  it('resolves to nothing when there is neither, leaving the client its initials tile', () => {
    expect(resolveIntegrationIcon('my-internal-api', {})).toBeUndefined();
  });

  it('degrades a malformed stored icon to the default instead of throwing', () => {
    // `definition_json` is unvalidated at rest, and one bad row must not fail
    // serialization for the whole list.
    expect(resolveIntegrationIcon('github', { icon: { kind: 'nonsense' } })).toEqual({
      kind: 'brand',
      assetId: 'github',
    });
    expect(resolveIntegrationIcon('my-internal-api', { icon: 'a-url-string' })).toBeUndefined();
  });
});

describe('mapDefinitionRow', () => {
  it('carries the resolved icon onto the response', () => {
    const row = {
      api_id: 'github',
      name: 'GitHub',
      base_url: 'https://api.github.com',
      version: '1',
      definition_json: { endpoints: [] },
    };

    expect(mapDefinitionRow(row).icon).toEqual({ kind: 'brand', assetId: 'github' });
  });

  it('omits the icon entirely rather than sending null', () => {
    const row = {
      api_id: 'my-internal-api',
      name: 'Internal',
      base_url: 'https://internal.example.com',
      version: '1',
      definition_json: { endpoints: [] },
    };

    expect('icon' in mapDefinitionRow(row)).toBe(false);
  });
});
