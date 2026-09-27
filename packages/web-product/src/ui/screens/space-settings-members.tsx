'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Table,
  Th,
  Td,
  Tr,
  Card,
  CardBody,
  Button,
  Badge,
  Text,
  Heading,
  Icon,
  Dialog,
  Input,
  Select,
  Label,
  Field,
  EmptyState,
  useBreakpoint,
} from '@aflow/design-system';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useSpace, useSpaceFromRoute } from '../components/providers.js';

// ============================================================================
// Types
// ============================================================================

interface Member {
  userId: string;
  role: 'admin' | 'editor' | 'viewer';
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

interface PendingGrant {
  id: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  createdAt: string;
}

// ============================================================================
// Page
// ============================================================================

export function SpaceMembersPage() {
  const { apiUrl, headers } = useApi();
  // Every read and every membership change is scoped by the space in the URL,
  // not the active one: `RouteSpaceBridge` syncs the active space in an effect,
  // so during a switch the previous space is still active for a render — long
  // enough to list, re-role, or remove members in the wrong one.
  const routeSpace = useSpaceFromRoute();
  const { isLoading: spacesLoading } = useSpace();
  const activeSpace = routeSpace;
  const activeSpaceId = routeSpace?.id ?? null;
  const { isMobile } = useBreakpoint();
  const queryClient = useQueryClient();

  const [members, setMembers] = useState<Member[]>([]);
  const [grants, setGrants] = useState<PendingGrant[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const isSpaceAdmin = activeSpace?.myRole === 'admin';

  const fetchMembers = useCallback(async () => {
    if (!activeSpaceId) return;
    setIsLoading(true);
    try {
      const response = await fetch(`${apiUrl}/spaces/${activeSpaceId}/members`, {
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      if (!response.ok) throw new Error('Failed to fetch members');
      const data = (await response.json()) as { members: Member[] };
      setMembers(data.members);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch members');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers, activeSpaceId]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const fetchGrants = useCallback(async () => {
    if (!activeSpaceId) return;
    try {
      const response = await fetch(`${apiUrl}/spaces/${activeSpaceId}/grants`, {
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      if (!response.ok) return;
      const data = (await response.json()) as { grants: PendingGrant[] };
      setGrants(data.grants);
    } catch {
      // Grants are supplementary — the members list stays usable without them.
    }
  }, [apiUrl, headers, activeSpaceId]);

  useEffect(() => {
    void fetchGrants();
  }, [fetchGrants]);

  const handleShare = useCallback(
    async (email: string, role: 'admin' | 'editor' | 'viewer') => {
      if (!activeSpaceId) return;
      const response = await fetch(`${apiUrl}/spaces/${activeSpaceId}/share`, {
        method: 'POST',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'X-Space-ID': activeSpaceId,
        },
        body: JSON.stringify({ email, role, acknowledgeSharing: true }),
      });
      if (!response.ok) throw new Error('Failed to share the space');
      void fetchMembers();
      void fetchGrants();
      void queryClient.invalidateQueries({ queryKey: ['space', activeSpaceId] });
      void queryClient.invalidateQueries({ queryKey: ['spaces'] });
    },
    [apiUrl, headers, activeSpaceId, fetchMembers, fetchGrants, queryClient],
  );

  const handleRevokeGrant = useCallback(
    async (grantId: string) => {
      if (!activeSpaceId) return;
      await fetch(`${apiUrl}/spaces/${activeSpaceId}/grants/${grantId}`, {
        method: 'DELETE',
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      void fetchGrants();
    },
    [apiUrl, headers, activeSpaceId, fetchGrants],
  );

  const handleUpdateRole = useCallback(
    async (userId: string, role: string) => {
      if (!activeSpaceId) return;
      await fetch(`${apiUrl}/spaces/${activeSpaceId}/members/${userId}`, {
        method: 'PATCH',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'X-Space-ID': activeSpaceId,
        },
        body: JSON.stringify({ role }),
      });
      void fetchMembers();
      void queryClient.invalidateQueries({ queryKey: ['space', activeSpaceId] });
    },
    [apiUrl, headers, activeSpaceId, fetchMembers, queryClient],
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!activeSpaceId) return;
      const confirmed = window.confirm('Remove this member from the space?');
      if (!confirmed) return;
      await fetch(`${apiUrl}/spaces/${activeSpaceId}/members/${userId}`, {
        method: 'DELETE',
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      void fetchMembers();
      void queryClient.invalidateQueries({ queryKey: ['space', activeSpaceId] });
    },
    [apiUrl, headers, activeSpaceId, fetchMembers, queryClient],
  );

  if (spacesLoading || isLoading) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Text variant="muted" size="sm">
            Loading...
          </Text>
        </Row>
      </PageContainer>
    );
  }

  if (!activeSpace) {
    return (
      <PageContainer>
        <EmptyState title="No space selected" description="Select a space from the sidebar." />
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer>
        <EmptyState title="Error" description={error} />
      </PageContainer>
    );
  }

  return (
    <>
      <PageContainer>
        <Column gap="lg">
          {isSpaceAdmin && (
            <Row justify="end">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setAddDialogOpen(true);
                }}
                leftIcon={<Icon name="plus" size="sm" />}
              >
                Share space
              </Button>
            </Row>
          )}
          {members.length === 0 ? (
            <Card>
              <CardBody>
                <Column gap="md" style={{ alignItems: 'center', padding: 'var(--space-6)' }}>
                  <Icon
                    name="users"
                    size="xl"
                    weight="thin"
                    color="var(--color-content-secondary)"
                  />
                  <Heading level={5}>No members</Heading>
                  <Text variant="muted" size="sm">
                    This space has no members yet.
                  </Text>
                </Column>
              </CardBody>
            </Card>
          ) : isMobile ? (
            <Column gap="sm">
              {members.map((m) => (
                <Card key={m.userId}>
                  <CardBody>
                    <Column gap="sm">
                      <Text size="sm" weight="medium">
                        {m.displayName ?? m.email ?? m.userId}
                      </Text>
                      {m.email && (
                        <Text variant="muted" size="xs">
                          {m.email}
                        </Text>
                      )}
                      <Row gap="sm" align="center">
                        <Badge variant={m.role === 'admin' ? 'warning' : 'neutral'}>{m.role}</Badge>
                        {isSpaceAdmin && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              void handleRemoveMember(m.userId);
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </Row>
                    </Column>
                  </CardBody>
                </Card>
              ))}
            </Column>
          ) : (
            <Table>
              <thead>
                <Tr>
                  <Th>User</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Added</Th>
                  {isSpaceAdmin && <Th style={{ width: 120 }}></Th>}
                </Tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <Tr key={m.userId}>
                    <Td>
                      <Text size="sm" weight="medium">
                        {m.displayName ?? m.userId.slice(0, 8)}
                      </Text>
                    </Td>
                    <Td>
                      <Text variant="muted" size="xs">
                        {m.email ?? '\u2014'}
                      </Text>
                    </Td>
                    <Td>
                      {isSpaceAdmin ? (
                        <Select
                          value={m.role}
                          onChange={(e) => {
                            void handleUpdateRole(m.userId, e.target.value);
                          }}
                          style={{ maxWidth: 120 }}
                        >
                          <option value="admin">Admin</option>
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </Select>
                      ) : (
                        <Badge variant={m.role === 'admin' ? 'warning' : 'neutral'}>{m.role}</Badge>
                      )}
                    </Td>
                    <Td>
                      <Text variant="muted" size="xs">
                        {new Date(m.createdAt).toLocaleDateString()}
                      </Text>
                    </Td>
                    {isSpaceAdmin && (
                      <Td>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => {
                            void handleRemoveMember(m.userId);
                          }}
                          leftIcon={<Icon name="trash" size="sm" />}
                        >
                          Remove
                        </Button>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}

          {grants.length > 0 && (
            <Column gap="sm">
              <Heading level={5}>Pending shares</Heading>
              <Card>
                <CardBody>
                  <Column gap="sm">
                    {grants.map((g, idx) => (
                      <Column key={g.id} gap="sm">
                        {idx > 0 && (
                          <div style={{ borderTop: '1px solid var(--color-border-subtle)' }} />
                        )}
                        <Row justify="between" align="center" wrap gap="sm">
                          <Column gap="xs" style={{ minWidth: 0 }}>
                            <Text size="sm">{g.email}</Text>
                            <Text size="xs" variant="muted">
                              {g.role} · shared {new Date(g.createdAt).toLocaleDateString()} · joins
                              on first sign-in
                            </Text>
                          </Column>
                          {isSpaceAdmin && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                void handleRevokeGrant(g.id);
                              }}
                            >
                              Revoke
                            </Button>
                          )}
                        </Row>
                      </Column>
                    ))}
                  </Column>
                </CardBody>
              </Card>
            </Column>
          )}
        </Column>
      </PageContainer>

      <ShareSpaceDialog
        open={addDialogOpen}
        onClose={() => {
          setAddDialogOpen(false);
        }}
        onShare={handleShare}
      />
    </>
  );
}

// ============================================================================
// Share Space Dialog
// ============================================================================

function ShareSpaceDialog({
  open,
  onClose,
  onShare,
}: {
  open: boolean;
  onClose: () => void;
  onShare: (email: string, role: 'admin' | 'editor' | 'viewer') => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('viewer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!email.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onShare(email.trim(), role);
      setEmail('');
      setRole('viewer');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to share the space');
    } finally {
      setSaving(false);
    }
  }, [email, role, onShare, onClose]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share this space"
      footer={
        <Row gap="sm">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            loading={saving}
            disabled={!email.trim()}
          >
            Share
          </Button>
        </Row>
      }
    >
      <Column gap="md">
        {error && (
          <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
            {error}
          </Text>
        )}
        <Text size="sm" variant="muted">
          They&apos;ll see this space&apos;s sessions, memory, and artifacts. If they&apos;re not a
          member here yet, access is granted the first time they sign in with this email.
        </Text>
        <Field>
          <Label>Email</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            placeholder="teammate@example.com"
          />
        </Field>
        <Field>
          <Label>Space role</Label>
          <Select
            value={role}
            onChange={(e) => {
              setRole(e.target.value as 'admin' | 'editor' | 'viewer');
            }}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
      </Column>
    </Dialog>
  );
}
