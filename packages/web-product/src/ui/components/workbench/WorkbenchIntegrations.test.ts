/**
 * @vitest-environment jsdom
 */
/**
 * The Integrations count, which the expanded header and the folded one share
 * (Plan 338 D3). An integration both unready and asked for in the Action
 * Center counts once.
 */
import { describe, expect, it } from 'vitest';

import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import type { SpaceIntegration } from '../../hooks/use-space-integrations.js';
import { countIntegrationsNeedingSetup } from './WorkbenchIntegrations.js';

function integration(key: string, readiness: SpaceIntegration['readiness']): SpaceIntegration {
  return {
    key,
    kind: 'mcp',
    family: 'callable',
    name: key,
    avatarKind: 'connector',
    readiness,
    detail: '',
  };
}

function consent(
  id: string,
  integrationKind: 'api' | 'mcp',
  resourceKey: string,
): ActionCenterItem {
  return {
    id,
    kind: 'needs_oauth_consent',
    extension: {
      kind: 'oauth_consent',
      integrationKind,
      resourceKey,
      bindingId: 'b',
      ownerScope: 'user',
      reason: 'never_connected',
    },
  } as unknown as ActionCenterItem;
}

describe('countIntegrationsNeedingSetup', () => {
  it('counts the unready integrations and leaves the ready and idle ones out', () => {
    const held = [
      integration('mcp:a', 'attention'),
      integration('mcp:b', 'error'),
      integration('mcp:c', 'ready'),
      integration('mcp:d', 'idle'),
    ];
    expect(countIntegrationsNeedingSetup(held, [])).toBe(2);
  });

  it('counts a connection request alone when no readiness is held', () => {
    expect(countIntegrationsNeedingSetup([], [consent('c1', 'api', 'github')])).toBe(1);
  });

  it('counts an integration once when it is unready and asked for', () => {
    const held = [integration('mcp:docs', 'attention')];
    const asked = [consent('c1', 'mcp', 'docs'), consent('c2', 'mcp', 'docs')];
    expect(countIntegrationsNeedingSetup(held, asked)).toBe(1);
  });
});
