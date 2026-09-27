/**
 * The directive this composer control writes is an ALLOWLIST, so the tests that
 * matter are the ones about membership, not about placement: a change that
 * stores a shorter list silently takes connections away from the agent, with no
 * error anywhere and nothing in the panel to say it happened.
 */
import { describe, expect, it } from 'vitest';
import type { DirectiveConnectionRef } from '@aflow/schemas';
import type { SpaceConnection } from '../components/cybernetic/ConnectionPlacementEditor.js';
import {
  connectionPlacements,
  coversBinding,
  placeConnection,
  pinnedToolsFor,
  setPinnedTools,
} from './connection-placements.js';

function connection(over: Partial<SpaceConnection> & { bindingId: string }): SpaceConnection {
  return {
    sourceKind: 'api',
    integrationId: over.bindingId,
    label: over.bindingId,
    toolCount: 3,
    alwaysOnTokens: 600,
    tools: [
      { name: 'one', label: 'One', tokens: 200 },
      { name: 'two', label: 'Two', tokens: 200 },
      { name: 'three', label: 'Three', tokens: 200 },
    ],
    pinnable: true,
    ...over,
  };
}

const etoro = connection({ bindingId: 'etoro-default', integrationId: 'etoro', label: 'eToro' });
const kaggle = connection({
  bindingId: 'kaggle-default',
  integrationId: 'kaggle',
  label: 'Kaggle',
  sourceKind: 'mcp',
});
const stripe = connection({ bindingId: 'stripe-default', integrationId: 'stripe' });
const all = [etoro, kaggle, stripe];

describe('placeConnection', () => {
  it('carries every connection forward when the agent had no stored list', () => {
    const next = placeConnection({
      stored: undefined,
      connections: all,
      connection: etoro,
      placement: 'always_on',
    });
    expect(next).toEqual([
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        placement: 'always_on',
      },
      {
        sourceKind: 'mcp',
        integrationId: 'kaggle',
        bindingId: 'kaggle-default',
        placement: 'on_demand',
      },
      {
        sourceKind: 'api',
        integrationId: 'stripe',
        bindingId: 'stripe-default',
        placement: 'on_demand',
      },
    ]);
  });

  it('stores no list when nothing is pinned and none was stored', () => {
    const pinned = placeConnection({
      stored: undefined,
      connections: all,
      connection: etoro,
      placement: 'always_on',
    });
    expect(
      placeConnection({
        stored: pinned,
        connections: all,
        connection: etoro,
        placement: 'on_demand',
      }),
    ).toEqual([
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        placement: 'on_demand',
      },
      {
        sourceKind: 'mcp',
        integrationId: 'kaggle',
        bindingId: 'kaggle-default',
        placement: 'on_demand',
      },
      {
        sourceKind: 'api',
        integrationId: 'stripe',
        bindingId: 'stripe-default',
        placement: 'on_demand',
      },
    ]);
    expect(
      placeConnection({
        stored: undefined,
        connections: all,
        connection: etoro,
        placement: 'on_demand',
      }),
    ).toBeUndefined();
  });

  it('leaves the connections it was not asked about out of a stored list', () => {
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        placement: 'on_demand',
      },
    ];
    const next = placeConnection({
      stored,
      connections: all,
      connection: etoro,
      placement: 'always_on',
    });
    expect(next).toEqual([
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        placement: 'always_on',
      },
    ]);
  });

  it('adds a connection the stored list omits, which is the only way back into reach', () => {
    // Storing a list at all freezes the agent's reach to the bindings of that
    // moment, so anything bound afterwards starts outside it.
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        placement: 'always_on',
      },
    ];
    expect(
      placeConnection({ stored, connections: all, connection: kaggle, placement: 'always_on' }),
    ).toEqual([
      ...stored,
      {
        sourceKind: 'mcp',
        integrationId: 'kaggle',
        bindingId: 'kaggle-default',
        placement: 'always_on',
      },
    ]);
  });

  it('keeps a stored list once nothing is pinned, because its membership is a reach decision', () => {
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        placement: 'always_on',
      },
    ];
    expect(
      placeConnection({ stored, connections: all, connection: etoro, placement: 'on_demand' }),
    ).toEqual([
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        placement: 'on_demand',
      },
    ]);
  });

  it('moves the whole-integration entry rather than adding a binding-scoped one', () => {
    const stored: DirectiveConnectionRef[] = [
      { sourceKind: 'api', integrationId: 'etoro', placement: 'on_demand' },
    ];
    expect(
      placeConnection({ stored, connections: all, connection: etoro, placement: 'always_on' }),
    ).toEqual([{ sourceKind: 'api', integrationId: 'etoro', placement: 'always_on' }]);
  });

  it('does not confuse an api integration with an mcp server of the same id', () => {
    const twin = connection({ bindingId: 'kaggle-api', integrationId: 'kaggle' });
    const next = placeConnection({
      stored: undefined,
      connections: [kaggle, twin],
      connection: twin,
      placement: 'always_on',
    });
    expect(next).toEqual([
      {
        sourceKind: 'mcp',
        integrationId: 'kaggle',
        bindingId: 'kaggle-default',
        placement: 'on_demand',
      },
      {
        sourceKind: 'api',
        integrationId: 'kaggle',
        bindingId: 'kaggle-api',
        placement: 'always_on',
      },
    ]);
  });
});

describe('connectionPlacements', () => {
  it('reports null when no list is stored, which is what grants every binding', () => {
    expect(connectionPlacements(undefined, all)).toBeNull();
  });

  it('leaves a connection the stored list omits out of the map', () => {
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro',
        bindingId: 'etoro-default',
        placement: 'always_on',
      },
    ];
    expect(connectionPlacements(stored, all)).toEqual({ 'etoro-default': 'always_on' });
  });

  it('answers for every binding of an integration entry that names none', () => {
    const second = connection({ bindingId: 'etoro-alt', integrationId: 'etoro' });
    const stored: DirectiveConnectionRef[] = [
      { sourceKind: 'api', integrationId: 'etoro', placement: 'always_on' },
    ];
    expect(connectionPlacements(stored, [etoro, second])).toEqual({
      'etoro-default': 'always_on',
      'etoro-alt': 'always_on',
    });
  });
});

describe('coversBinding', () => {
  it('matches on source kind, integration and binding', () => {
    const entry: DirectiveConnectionRef = {
      sourceKind: 'api',
      integrationId: 'etoro',
      bindingId: 'etoro-default',
      placement: 'on_demand',
    };
    expect(coversBinding(entry, etoro)).toBe(true);
    expect(
      coversBinding(entry, connection({ bindingId: 'etoro-alt', integrationId: 'etoro' })),
    ).toBe(false);
    expect(coversBinding({ ...entry, sourceKind: 'mcp' }, etoro)).toBe(false);
  });
});

describe('setPinnedTools', () => {
  const etoro = connection({ bindingId: 'etoro-default' });

  it('narrows a stored entry to the named tools', () => {
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro-default',
        bindingId: 'etoro-default',
        placement: 'always_on',
      },
    ];
    const next = setPinnedTools({ stored, connection: etoro, toolNames: ['one'] });
    expect(next?.[0]?.pinnedToolNames).toEqual(['one']);
    // Tier moved; reach did not.
    expect(next?.[0]?.placement).toBe('always_on');
    expect(next).toHaveLength(1);
  });

  it('clears the narrowing rather than storing every name, so a later tool is included', () => {
    // Storing the full list would freeze the selection to today's endpoints —
    // an endpoint added to the connector afterwards would arrive unpinned for
    // an operator who had chosen "all".
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro-default',
        bindingId: 'etoro-default',
        placement: 'always_on',
        pinnedToolNames: ['one'],
      },
    ];
    const next = setPinnedTools({ stored, connection: etoro, toolNames: undefined });
    expect(next?.[0]).not.toHaveProperty('pinnedToolNames');
  });

  it('leaves every other entry untouched', () => {
    const other = connection({ bindingId: 'kaggle-default' });
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro-default',
        bindingId: 'etoro-default',
        placement: 'always_on',
      },
      {
        sourceKind: 'api',
        integrationId: 'kaggle-default',
        bindingId: 'kaggle-default',
        placement: 'always_on',
      },
    ];
    const next = setPinnedTools({ stored, connection: etoro, toolNames: ['one'] });
    expect(next?.find((e) => coversBinding(e, other))).toEqual(stored[1]);
  });
});

describe('pinnedToolsFor', () => {
  it('reports null for an entry that pins everything', () => {
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro-default',
        bindingId: 'etoro-default',
        placement: 'always_on',
      },
    ];
    expect(pinnedToolsFor(stored, connection({ bindingId: 'etoro-default' }))).toBeNull();
  });

  it('reports the stored subset', () => {
    const stored: DirectiveConnectionRef[] = [
      {
        sourceKind: 'api',
        integrationId: 'etoro-default',
        bindingId: 'etoro-default',
        placement: 'always_on',
        pinnedToolNames: ['two'],
      },
    ];
    expect(pinnedToolsFor(stored, connection({ bindingId: 'etoro-default' }))).toEqual(['two']);
  });
});
