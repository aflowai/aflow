'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Button,
  Text,
  Input,
  Label,
  Field,
  Badge,
} from '@aflow/design-system';
import { useCurrentUser } from '../components/user-avatar.js';
import { useApiMutation } from '../hooks/useApiQuery.js';

// ============================================================================
// Page
// ============================================================================

export function AccountProfilePage() {
  const currentUser = useCurrentUser();

  const [displayName, setDisplayName] = useState('');
  const [originalName, setOriginalName] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (currentUser?.displayName) {
      setDisplayName(currentUser.displayName);
      setOriginalName(currentUser.displayName);
    }
  }, [currentUser?.displayName]);

  const hasChanges = displayName.trim() !== originalName;

  const profileMutation = useApiMutation<{ displayName: string }>({
    path: '/users/me',
    method: 'PATCH',
    // The whole space prefix: rosters, presence and member lists all render
    // this name, and a rename that keeps showing the old one for the cache's
    // lifetime reads as a failed save. Renames are rare; the refetch is cheap.
    invalidate: [['users', 'me'], ['space']],
  });

  const handleSave = useCallback(async () => {
    if (!hasChanges || !displayName.trim()) return;
    setError(null);
    setSaved(false);
    try {
      await profileMutation.mutateAsync({ displayName: displayName.trim() });
      setOriginalName(displayName.trim());
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    }
  }, [displayName, hasChanges, profileMutation]);

  const saving = profileMutation.isPending;

  if (!currentUser) {
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

  return (
    <PageContainer>
      <Column gap="lg" style={{ maxWidth: 480 }}>
        <Card>
          <CardBody>
            <Column gap="md">
              <Field>
                <Label>Display Name</Label>
                <Input
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                  }}
                  placeholder="Your name"
                />
              </Field>

              <Field>
                <Label>Email</Label>
                <Input value={currentUser.email ?? ''} readOnly disabled />
              </Field>

              {error && (
                <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
                  {error}
                </Text>
              )}

              <Row gap="sm" align="center">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    void handleSave();
                  }}
                  loading={saving}
                  disabled={!hasChanges || !displayName.trim()}
                >
                  Save
                </Button>
                {saved && <Badge variant="success">Saved</Badge>}
              </Row>
            </Column>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Column gap="sm">
              <Text size="sm" weight="medium">
                Tenant Role
              </Text>
              <Badge variant={currentUser.isAdmin ? 'warning' : 'neutral'}>
                {currentUser.isAdmin ? 'Admin' : 'Member'}
              </Badge>
            </Column>
          </CardBody>
        </Card>
      </Column>
    </PageContainer>
  );
}
