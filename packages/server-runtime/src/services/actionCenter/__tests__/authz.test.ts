import { describe, expect, it } from 'vitest';
import type { ActionCenterItem, ResolverPolicy } from '@aflow/schemas';
import {
  ActionCenterAuthzError,
  assertResolutionAllowed,
  computeAllowedActions,
  projectActionCenterItem,
  type ActionCenterReader,
  type ActionCenterResolverAuthority,
} from '../authz.js';
import type { ActionCenterPooledItem } from '../types.js';

function reader(
  actorSpaceRole: ActionCenterReader['actorSpaceRole'],
  overrides: Partial<ActionCenterReader> = {},
): ActionCenterReader {
  return { actorUserId: 'u', actorSpaceRole, actorIsTenantAdmin: false, ...overrides };
}

function item(overrides: Partial<ActionCenterPooledItem> = {}): ActionCenterPooledItem {
  return {
    id: 'step:abc',
    spaceId: '00000000-0000-0000-0000-000000000001',
    kind: 'human_approval',
    origin: {
      type: 'step',
      runId: 'r-1',
      stepExecutionId: 'se-1',
      sessionId: 's-1',
      pauseVersion: 0,
      operationId: 'user.interaction.approve',
    },
    title: 't',
    summary: 's',
    requestedAt: new Date().toISOString(),
    requestedBy: { kind: 'agent', label: 'agent' },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'space' } as ActionCenterResolverAuthority,
    status: 'open',
    ...overrides,
  } as unknown as ActionCenterPooledItem;
}

describe('computeAllowedActions', () => {
  it('viewer gets nothing regardless of kind', () => {
    for (const kind of [
      'human_input',
      'human_approval',
      'ratification',
      'platform_issue',
    ] as const) {
      expect(
        computeAllowedActions({
          itemKind: kind,
          authority: { kind: 'space' },
          reader: reader('viewer'),
        }),
      ).toEqual([]);
    }
  });

  it('editor can submit a human_input item', () => {
    expect(
      computeAllowedActions({
        itemKind: 'human_input',
        authority: { kind: 'space' },
        reader: reader('editor', { actorUserId: 'u' }),
      }),
    ).toEqual(['submit', 'reassign']);
  });

  it('admin can approve and reject a human_approval item', () => {
    expect(
      computeAllowedActions({
        itemKind: 'human_approval',
        authority: { kind: 'space' },
        reader: reader('admin', { actorUserId: 'u' }),
      }),
    ).toEqual(['approve', 'reject', 'reassign']);
  });

  it('editor can ratify and reject a ratification item (dismiss reserved for platform_issue)', () => {
    expect(
      computeAllowedActions({
        itemKind: 'ratification',
        authority: { kind: 'space' },
        reader: reader('editor', { actorUserId: 'u' }),
      }),
    ).toEqual(['ratify', 'reject']);
  });

  it('platform_issue is dismiss-only (Plan 138 §2.6)', () => {
    expect(
      computeAllowedActions({
        itemKind: 'platform_issue',
        authority: { kind: 'space' },
        reader: reader('admin', { actorUserId: 'u' }),
      }),
    ).toEqual(['dismiss']);
  });

  it('candidateResolvers allowlist excludes non-listed users from answering', () => {
    const policy: ResolverPolicy = {
      minResolvers: 1,
      requireAll: false,
      candidateResolvers: ['allowed-user'],
    };
    // The answer is not theirs to give, but routing attention still is —
    // an unnamed editor can hand the request to the person it needs.
    expect(
      computeAllowedActions({
        itemKind: 'human_approval',
        resolverPolicy: policy,
        authority: { kind: 'space' },
        reader: reader('editor', { actorUserId: 'other-user' }),
      }),
    ).toEqual(['reassign']);
  });

  it('candidateResolvers allowlist accepts listed users', () => {
    const policy: ResolverPolicy = {
      minResolvers: 1,
      requireAll: false,
      candidateResolvers: ['allowed-user'],
    };
    expect(
      computeAllowedActions({
        itemKind: 'human_approval',
        resolverPolicy: policy,
        authority: { kind: 'space' },
        reader: reader('editor', { actorUserId: 'allowed-user' }),
      }),
    ).toEqual(['approve', 'reject', 'reassign']);
  });

  it('candidateResolvers may include roles, not just user ids', () => {
    const policy: ResolverPolicy = {
      minResolvers: 1,
      requireAll: false,
      candidateResolvers: ['admin'], // role-based allowlist
    };
    expect(
      computeAllowedActions({
        itemKind: 'human_approval',
        resolverPolicy: policy,
        authority: { kind: 'space' },
        reader: reader('admin', { actorUserId: 'some-user' }),
      }),
    ).toEqual(['approve', 'reject', 'reassign']);
  });

  it('empty candidateResolvers is treated as "no allowlist"', () => {
    const policy: ResolverPolicy = {
      minResolvers: 1,
      requireAll: false,
      candidateResolvers: [],
    };
    expect(
      computeAllowedActions({
        itemKind: 'human_approval',
        resolverPolicy: policy,
        authority: { kind: 'space' },
        reader: reader('editor', { actorUserId: 'anyone' }),
      }),
    ).toEqual(['approve', 'reject', 'reassign']);
  });
});

describe('assertResolutionAllowed', () => {
  it('passes silently when the kind is in the allowed set', () => {
    expect(() =>
      assertResolutionAllowed(
        item({ kind: 'human_approval' }),
        'approve',
        reader('editor', { actorUserId: 'u' }),
      ),
    ).not.toThrow();
  });

  it('throws ActionCenterAuthzError when the kind is forbidden by role', () => {
    expect(() =>
      assertResolutionAllowed(
        item({ kind: 'human_approval' }),
        'approve',
        reader('viewer', { actorUserId: 'u' }),
      ),
    ).toThrow(ActionCenterAuthzError);
  });

  it('throws when the kind is wrong for the item (e.g. ratify on human_input)', () => {
    expect(() =>
      assertResolutionAllowed(
        item({ kind: 'human_input' }),
        'ratify',
        reader('admin', { actorUserId: 'u' }),
      ),
    ).toThrow(ActionCenterAuthzError);
  });

  it('respects resolverPolicy.candidateResolvers in the assertion path', () => {
    const itemWithPolicy = item({
      kind: 'human_approval',
      resolverPolicy: {
        minResolvers: 1,
        requireAll: false,
        candidateResolvers: ['allowed-user'],
      },
    });
    expect(() =>
      assertResolutionAllowed(
        itemWithPolicy,
        'approve',
        reader('admin', { actorUserId: 'other-user' }),
      ),
    ).toThrow(ActionCenterAuthzError);
    expect(() =>
      assertResolutionAllowed(
        itemWithPolicy,
        'approve',
        reader('admin', { actorUserId: 'allowed-user' }),
      ),
    ).not.toThrow();
  });
});

describe('resolverAuthority', () => {
  it('a view-only item offers nothing to anyone, including a space admin', () => {
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      expect(
        computeAllowedActions({
          itemKind: 'human_approval',
          originType: 'workflow_task',
          authority: { kind: 'view_only' },
          reader: reader(role, { actorIsTenantAdmin: true }),
        }),
      ).toEqual([]);
    }
  });

  it('a tenant-wide grant offers nothing to a space admin who is not a tenant admin', () => {
    const args = {
      itemKind: 'human_approval' as const,
      originType: 'settings' as const,
      resolverPolicy: { minResolvers: 1, requireAll: false, candidateResolvers: ['admin'] },
      authority: { kind: 'tenant_admin' } as const,
    };
    expect(
      computeAllowedActions({ ...args, reader: reader('admin', { actorIsTenantAdmin: false }) }),
    ).toEqual([]);
    expect(
      computeAllowedActions({ ...args, reader: reader('admin', { actorIsTenantAdmin: true }) }),
    ).toEqual(['approve', 'reject']);
  });

  it('a named-user item answers only to that person, whatever their space role', () => {
    const args = {
      itemKind: 'session_invitation' as const,
      originType: 'session_invitation' as const,
      authority: { kind: 'named_user', userId: 'invitee' } as const,
    };
    expect(
      computeAllowedActions({ ...args, reader: reader('viewer', { actorUserId: 'invitee' }) }),
    ).toEqual(['approve', 'reject']);
    expect(
      computeAllowedActions({ ...args, reader: reader('admin', { actorUserId: 'bystander' }) }),
    ).toEqual([]);
  });

  it('projects the same stored item differently for two readers', () => {
    const pooled = item({ kind: 'human_approval' });
    const asEditor = projectActionCenterItem(reader('editor', { actorUserId: 'a' }), pooled);
    const asViewer = projectActionCenterItem(reader('viewer', { actorUserId: 'b' }), pooled);
    expect(asEditor.allowedActions).toEqual(['approve', 'reject', 'reassign']);
    expect(asViewer.allowedActions).toEqual([]);
  });

  it('refuses a view-only resolution without blaming the caller\u2019s role', () => {
    const viewOnly = item({ resolverAuthority: { kind: 'view_only' } });
    expect(() => assertResolutionAllowed(viewOnly, 'approve', reader('admin'))).toThrow(
      /answered on its own surface/,
    );
  });

  it('never sends the authority to the client', () => {
    const projected = projectActionCenterItem(reader('editor'), item());
    expect('resolverAuthority' in projected).toBe(false);
  });
});
