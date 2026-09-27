/**
 * Which space-settings tabs an edition serves.
 *
 * Two different questions share this table and must not be collapsed into one:
 * a surface tab is absent because the route is not registered and would 404,
 * and an edition tab is absent although the route is registered, because the
 * capability behind it belongs to the other product.
 */
import { describe, expect, it } from 'vitest';

import { spaceSettingsTabPaths } from './spaceSettingsTabs.js';

function labels(id: 'enterprise' | 'community-local' | null, surfaces: string[] = []): string[] {
  return spaceSettingsTabPaths({ id, surfaces: new Set(surfaces) }, false).map((t) => t.label);
}

describe('the hosted edition', () => {
  it('serves the space-scoped OAuth apps tab', () => {
    expect(labels('enterprise')).toContain('OAuth Apps');
  });

  it('serves the coding-lane tab beside it', () => {
    expect(labels('enterprise')).toContain('Coding Lane');
  });

  it('serves Members only where the membership surface was composed', () => {
    expect(labels('enterprise')).not.toContain('Members');
    expect(labels('enterprise', ['space-members'])).toContain('Members');
  });
});

describe('the local edition', () => {
  it('withholds the space-scoped OAuth apps tab', () => {
    expect(labels('community-local')).not.toContain('OAuth Apps');
  });

  it('still serves what an appliance operator configures here', () => {
    expect(labels('community-local')).toEqual([
      'General',
      'Agent',
      'Rules',
      'Compute',
      'Write Policy',
      'Credentials',
      'Danger zone',
    ]);
  });
});

describe('before the server has answered', () => {
  it('withholds every edition-owned tab rather than showing one that then goes', () => {
    expect(labels(null)).not.toContain('OAuth Apps');
    expect(labels(null)).not.toContain('Coding Lane');
  });
});

describe('a solo space', () => {
  it('gains Memory directly after Rules', () => {
    const paths = spaceSettingsTabPaths({ id: 'community-local', surfaces: new Set() }, true).map(
      (t) => t.label,
    );
    expect(paths[paths.indexOf('Rules') + 1]).toBe('Memory');
  });
});
