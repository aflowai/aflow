/**
 * Settings → Profiles is the local owner's tab (Plan 335 P2). The edition
 * decides it, because the route is registered in both editions and refused in
 * the hosted one. The owner role decides it within the local edition.
 */
import { describe, expect, it } from 'vitest';

import { firstSettingsTab, visibleSettingsTabs } from './tabs.js';

const LOCAL_SURFACES = ['api-keys', 'credentials', 'tenant-settings', 'admin-capability-profiles'];

function labels(
  id: 'enterprise' | 'community-local' | null,
  isOwner: boolean,
  surfaces: string[] = LOCAL_SURFACES,
): string[] {
  return visibleSettingsTabs({ edition: { id, surfaces: new Set(surfaces) }, isOwner }).map(
    (tab) => tab.label,
  );
}

describe('the Profiles tab', () => {
  it('shows for the local owner', () => {
    expect(labels('community-local', true)).toContain('Profiles');
  });

  it('is withheld from a local profile that is not the owner', () => {
    expect(labels('community-local', false)).not.toContain('Profiles');
  });

  it('is withheld from the hosted edition, owner or not', () => {
    expect(labels('enterprise', true)).not.toContain('Profiles');
  });

  it('is withheld before the server has said which edition this is', () => {
    expect(labels(null, true)).not.toContain('Profiles');
  });
});

describe('the tab Settings opens on', () => {
  it('stays API Keys for the local owner', () => {
    expect(
      firstSettingsTab({
        edition: { id: 'community-local', surfaces: new Set(LOCAL_SURFACES) },
        isOwner: true,
      }),
    ).toBe('/settings/api-keys');
  });

  it('stays Members where the hosted edition composes it', () => {
    expect(
      firstSettingsTab({
        edition: { id: 'enterprise', surfaces: new Set(['tenant-members', ...LOCAL_SURFACES]) },
        isOwner: true,
      }),
    ).toBe('/settings/members');
  });
});
