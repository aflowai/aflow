import { describe, it, expect } from 'vitest';
import { equivalentRouteInSpace, spaceRoute, resolveSpaceSlug } from './space-routes.js';

describe('spaceRoute', () => {
  it('prepends the space prefix to a path', () => {
    expect(spaceRoute('acme', '/chat')).toBe('/s/acme/chat');
  });
  it('preserves the query string', () => {
    expect(spaceRoute('acme', '/chat?agentId=foo')).toBe('/s/acme/chat?agentId=foo');
  });
  it('returns the input untouched when no slug is provided', () => {
    expect(spaceRoute(undefined, '/chat')).toBe('/chat');
  });
});

describe('equivalentRouteInSpace', () => {
  it('drops resource id when switching deep into agents', () => {
    expect(equivalentRouteInSpace('/s/old/agents/research-bot/edit', 'new')).toBe('/s/new/agents');
    expect(equivalentRouteInSpace('/s/old/agents/research-bot', 'new')).toBe('/s/new/agents');
  });

  it('keeps the agents list page intact', () => {
    expect(equivalentRouteInSpace('/s/old/agents', 'new')).toBe('/s/new/agents');
    expect(equivalentRouteInSpace('/s/old/agents/new', 'new')).toBe('/s/new/agents');
  });

  it('drops session id when switching from a session detail', () => {
    expect(equivalentRouteInSpace('/s/old/sessions/abc-123', 'new')).toBe('/s/new/sessions');
  });

  it('drops memory tail when switching from a deep memory path', () => {
    expect(equivalentRouteInSpace('/s/old/memory/some/path', 'new')).toBe('/s/new/memory');
  });

  it('drops integration id when switching from an integration detail', () => {
    expect(equivalentRouteInSpace('/s/old/integrations/stripe', 'new')).toBe('/s/new/integrations');
  });

  it('drops the skill slug when switching from a skill detail', () => {
    expect(equivalentRouteInSpace('/s/old/skills/research-helper', 'new')).toBe('/s/new/skills');
  });

  it('keeps store listing paths — the catalog is platform-owned, valid in any space', () => {
    expect(equivalentRouteInSpace('/s/old/store/kaggle-optimizer', 'new')).toBe(
      '/s/new/store/kaggle-optimizer',
    );
  });

  it('preserves settings tabs across spaces', () => {
    expect(equivalentRouteInSpace('/s/old/settings/agent', 'new')).toBe('/s/new/settings/agent');
    expect(equivalentRouteInSpace('/s/old/settings/general', 'new')).toBe(
      '/s/new/settings/general',
    );
  });

  it('preserves chat, memory list, directives, training, catalog, action-center', () => {
    expect(equivalentRouteInSpace('/s/old/chat', 'new')).toBe('/s/new/chat');
    expect(equivalentRouteInSpace('/s/old/memory', 'new')).toBe('/s/new/memory');
    expect(equivalentRouteInSpace('/s/old/directives', 'new')).toBe('/s/new/directives');
    expect(equivalentRouteInSpace('/s/old/training', 'new')).toBe('/s/new/training');
    expect(equivalentRouteInSpace('/s/old/catalog', 'new')).toBe('/s/new/catalog');
    expect(equivalentRouteInSpace('/s/old/action-center', 'new')).toBe('/s/new/action-center');
  });

  it('drops the query string', () => {
    expect(equivalentRouteInSpace('/s/old/chat?agentId=foo', 'new')).toBe('/s/new/chat');
  });

  it('sends tenant-scoped URLs to the chat of the new space', () => {
    expect(equivalentRouteInSpace('/account', 'new')).toBe('/s/new/chat');
    expect(equivalentRouteInSpace('/settings/members', 'new')).toBe('/s/new/chat');
    expect(equivalentRouteInSpace('/', 'new')).toBe('/s/new/chat');
  });

  it('handles the bare space root', () => {
    expect(equivalentRouteInSpace('/s/old', 'new')).toBe('/s/new/chat');
    expect(equivalentRouteInSpace('/s/old/', 'new')).toBe('/s/new/chat');
  });

  it('encodes slugs that need it (defensive — slugs are already kebab in practice)', () => {
    expect(equivalentRouteInSpace('/s/old/chat', 'with space')).toBe('/s/with%20space/chat');
  });
});

describe('resolveSpaceSlug', () => {
  it('returns the active space slug when ids match', () => {
    expect(
      resolveSpaceSlug([{ id: 'a', slug: 'general' }], 'a', { id: 'a', slug: 'general' }),
    ).toBe('general');
  });
  it('falls back to the spaces list when no active match', () => {
    expect(
      resolveSpaceSlug(
        [
          { id: 'a', slug: 'general' },
          { id: 'b', slug: 'acme' },
        ],
        'b',
        null,
      ),
    ).toBe('acme');
  });
  it('returns undefined when the id is unknown', () => {
    expect(resolveSpaceSlug([{ id: 'a', slug: 'general' }], 'z', null)).toBeUndefined();
  });
});
