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
  Heading,
  Input,
  Textarea,
  Select,
  Label,
  Field,
  HelperText,
  Icon,
  Badge,
} from '@aflow/design-system';
import { useSpace, useSpaceFromRoute } from '../components/providers.js';
import { useFlows } from '../hooks/use-flows.js';
import { useSpaceDetail } from '../hooks/use-space-detail.js';
import { useApiMutation } from '../hooks/useApiQuery.js';

// ============================================================================
// Page
// ============================================================================

export function SpaceGeneralPage() {
  const { activeSpace, activeSpaceId, isLoading: spacesLoading, refresh } = useSpace();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? activeSpaceId ?? '';
  const { flows, isLoading: flowsLoading } = useFlows(spaceId);

  const { space, isLoading, error } = useSpaceDetail(activeSpaceId);

  // Form state — initialized from the cache as soon as it arrives.
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [defaultAgentId, setDefaultFlowId] = useState('');

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isSpaceAdmin = activeSpace?.myRole === 'admin';

  useEffect(() => {
    if (!space) return;
    setName(space.name);
    setSlug(space.slug);
    setDescription(space.description ?? '');
    setDefaultFlowId(space.defaultAgentId ?? '');
  }, [space]);

  const hasChanges =
    space !== null &&
    (name !== space.name ||
      slug !== space.slug ||
      description !== (space.description ?? '') ||
      defaultAgentId !== (space.defaultAgentId ?? ''));

  const saveMutation = useApiMutation<{
    name?: string;
    slug?: string;
    description?: string | null;
    defaultAgentId?: string | null;
  }>({
    path: activeSpaceId ? `/spaces/${activeSpaceId}` : '/spaces',
    method: 'PATCH',
    ...(activeSpaceId
      ? { invalidate: [['space', activeSpaceId, 'detail'], ['spaces']] }
      : { invalidate: [['spaces']] }),
  });

  const handleSave = useCallback(async () => {
    if (!activeSpaceId || !hasChanges) return;
    setSaveError(null);
    setSaved(false);
    try {
      const body: {
        name?: string;
        slug?: string;
        description?: string | null;
        defaultAgentId?: string | null;
      } = {};
      if (name !== space?.name) body.name = name;
      if (slug !== space?.slug) body.slug = slug;
      if (description !== (space?.description ?? '')) body.description = description || null;
      if (defaultAgentId !== (space?.defaultAgentId ?? ''))
        body.defaultAgentId = defaultAgentId || null;

      await saveMutation.mutateAsync(body);
      setSaved(true);
      refresh();
      // Clear success indicator after a moment
      setTimeout(() => {
        setSaved(false);
      }, 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    }
  }, [
    activeSpaceId,
    hasChanges,
    name,
    slug,
    description,
    defaultAgentId,
    space,
    saveMutation,
    refresh,
  ]);

  // ---------------------------------------------------------------------------
  // Loading / empty states
  // ---------------------------------------------------------------------------

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

  if (!activeSpace || !space) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Text variant="muted" size="sm">
            {error ?? 'No space selected'}
          </Text>
        </Row>
      </PageContainer>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <PageContainer>
      <Column gap="lg">
        <Row justify="end" align="center" gap="sm">
          {saved && (
            <Row gap="xs" align="center">
              <Icon name="check" size="sm" color="var(--color-status-success-fg)" />
              <Text size="xs" style={{ color: 'var(--color-status-success-fg)' }}>
                Saved
              </Text>
            </Row>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!hasChanges || saveMutation.isPending}
            onClick={() => {
              void handleSave();
            }}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save Changes'}
          </Button>
        </Row>
        {saveError && (
          <Card>
            <CardBody>
              <Row gap="sm" align="center">
                <Icon name="warning" size="sm" color="var(--color-status-failed-fg)" />
                <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
                  {saveError}
                </Text>
              </Row>
            </CardBody>
          </Card>
        )}

        {/* Basic Info */}
        <section>
          <Column gap="md">
            <Heading level={5}>Basic Info</Heading>

            <Field>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                disabled={!isSpaceAdmin}
                placeholder="Space name"
              />
            </Field>

            <Field>
              <Label>Slug</Label>
              <Input
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                }}
                disabled={!isSpaceAdmin}
                placeholder="url-friendly-slug"
              />
              <HelperText>Lowercase letters, numbers, and hyphens only.</HelperText>
            </Field>

            <Field>
              <Label>Description</Label>
              <Textarea
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
                disabled={!isSpaceAdmin}
                placeholder="What is this space for?"
                rows={3}
              />
            </Field>
          </Column>
        </section>

        {/* Default Agent */}
        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Default Agent</Heading>
              <Text size="xs" variant="muted">
                The agent that opens automatically when starting a new chat in this space.
              </Text>
            </Column>

            <Field>
              <Label>Agent</Label>
              <Select
                value={defaultAgentId}
                onChange={(e) => {
                  setDefaultFlowId(e.target.value);
                }}
                disabled={!isSpaceAdmin || flowsLoading}
              >
                <option value="">No default agent</option>
                {flows.map((f) => (
                  <option key={f.agentId} value={f.agentId}>
                    {f.name}
                  </option>
                ))}
              </Select>
              {flowsLoading && <HelperText>Loading agents...</HelperText>}
            </Field>
          </Column>
        </section>

        {/* Space Info (read-only) */}
        <section>
          <Column gap="md">
            <Heading level={5}>Details</Heading>
            <Card>
              <CardBody>
                <Column gap="sm">
                  <Row justify="between" align="center">
                    <Text size="xs" variant="muted">
                      Sharing
                    </Text>
                    <Badge variant={(space.memberCount ?? 1) <= 1 ? 'accent' : 'neutral'}>
                      {(space.memberCount ?? 1) <= 1
                        ? 'personal'
                        : `shared · ${space.memberCount} members`}
                    </Badge>
                  </Row>
                  <div style={{ borderTop: '1px solid var(--color-border-subtle)' }} />
                  <Row justify="between" align="center">
                    <Text size="xs" variant="muted">
                      Your Role
                    </Text>
                    <Badge variant={activeSpace.myRole === 'admin' ? 'warning' : 'neutral'}>
                      {activeSpace.myRole ?? 'none'}
                    </Badge>
                  </Row>
                  <div style={{ borderTop: '1px solid var(--color-border-subtle)' }} />
                  <Row justify="between" align="center">
                    <Text size="xs" variant="muted">
                      Created
                    </Text>
                    <Text size="xs">
                      {space.createdAt ? new Date(space.createdAt).toLocaleDateString() : '—'}
                    </Text>
                  </Row>
                  <div style={{ borderTop: '1px solid var(--color-border-subtle)' }} />
                  <Row justify="between" align="center">
                    <Text size="xs" variant="muted">
                      Last Updated
                    </Text>
                    <Text size="xs">
                      {space.updatedAt ? new Date(space.updatedAt).toLocaleDateString() : '—'}
                    </Text>
                  </Row>
                </Column>
              </CardBody>
            </Card>
          </Column>
        </section>
      </Column>
    </PageContainer>
  );
}
