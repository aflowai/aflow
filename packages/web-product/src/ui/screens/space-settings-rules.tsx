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
  Icon,
  IconButton,
} from '@aflow/design-system';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useSpace } from '../components/providers.js';

// ============================================================================
// Types
// ============================================================================

interface SpaceRule {
  text: string;
}

// ============================================================================
// Page
// ============================================================================

export function SpaceRulesPage() {
  const { apiUrl, headers } = useApi();
  const { activeSpace, activeSpaceId, isLoading: spacesLoading } = useSpace();
  const queryClient = useQueryClient();

  const [rules, setRules] = useState<SpaceRule[]>([]);
  const [savedRules, setSavedRules] = useState<SpaceRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isSpaceAdmin = activeSpace?.myRole === 'admin';

  const fetchRules = useCallback(async () => {
    if (!activeSpaceId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/rules`, {
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      if (!res.ok) throw new Error('Failed to load rules');
      const data = (await res.json()) as { rules: SpaceRule[] };
      setRules(data.rules);
      setSavedRules(data.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers, activeSpaceId]);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  const hasChanges = JSON.stringify(rules) !== JSON.stringify(savedRules);

  const handleSave = useCallback(async () => {
    if (!activeSpaceId || !hasChanges) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      // Filter out empty rules before saving
      const cleanRules = rules.filter((r) => r.text.trim().length > 0);
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/rules`, {
        method: 'PUT',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'X-Space-ID': activeSpaceId,
        },
        body: JSON.stringify({ rules: cleanRules }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? 'Failed to save');
      }
      const data = (await res.json()) as { rules: SpaceRule[] };
      setRules(data.rules);
      setSavedRules(data.rules);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['space', activeSpaceId] });
      setTimeout(() => {
        setSaved(false);
      }, 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [activeSpaceId, hasChanges, rules, apiUrl, headers]);

  const addRule = () => {
    setRules([...rules, { text: '' }]);
  };

  const updateRule = (index: number, text: string) => {
    const updated = [...rules];
    const rule = updated[index];
    if (rule) {
      rule.text = text;
      setRules(updated);
    }
  };

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  const moveRule = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const updated = [...rules];
    const item = updated[index];
    const swap = updated[target];
    if (item && swap) {
      updated[index] = swap;
      updated[target] = item;
      setRules(updated);
    }
  };

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

  if (!activeSpace) {
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
            disabled={!hasChanges || saving}
            onClick={() => {
              void handleSave();
            }}
          >
            {saving ? 'Saving…' : 'Save Changes'}
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

        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Agent Rules</Heading>
              <Text size="xs" variant="muted">
                Behavioral directives injected into every agent turn in this space. Rules guide how
                agents respond, what they prioritize, and what constraints to follow.
              </Text>
            </Column>

            {rules.length === 0 && (
              <Card>
                <CardBody>
                  <Column gap="sm" align="center" style={{ padding: 'var(--space-4)' }}>
                    <Text variant="muted" size="sm">
                      No rules defined yet.
                    </Text>
                    {isSpaceAdmin && (
                      <Text variant="muted" size="xs">
                        Add rules to guide agent behavior in this space.
                      </Text>
                    )}
                  </Column>
                </CardBody>
              </Card>
            )}

            {rules.map((rule, index) => (
              <Card key={index}>
                <CardBody>
                  <Row gap="sm" align="start">
                    <Text
                      size="xs"
                      variant="muted"
                      style={{
                        minWidth: 20,
                        paddingTop: 'var(--space-2)',
                        textAlign: 'right',
                      }}
                    >
                      {index + 1}.
                    </Text>
                    <div style={{ flex: 1 }}>
                      <Input
                        value={rule.text}
                        onChange={(e) => {
                          updateRule(index, e.target.value);
                        }}
                        disabled={!isSpaceAdmin}
                        placeholder="e.g., Always respond in German"
                        maxLength={500}
                      />
                    </div>
                    {isSpaceAdmin && (
                      <Row gap="xs">
                        <IconButton
                          icon={<Icon name="caret-up" size="xs" />}
                          aria-label="Move up"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            moveRule(index, -1);
                          }}
                          disabled={index === 0}
                        />
                        <IconButton
                          icon={<Icon name="caret-down" size="xs" />}
                          aria-label="Move down"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            moveRule(index, 1);
                          }}
                          disabled={index === rules.length - 1}
                        />
                        <IconButton
                          icon={<Icon name="trash" size="xs" />}
                          aria-label="Remove rule"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            removeRule(index);
                          }}
                        />
                      </Row>
                    )}
                  </Row>
                </CardBody>
              </Card>
            ))}

            {isSpaceAdmin && rules.length < 50 && (
              <Button variant="ghost" size="sm" onClick={addRule}>
                <Icon name="plus" size="xs" />
                Add Rule
              </Button>
            )}
          </Column>
        </section>
      </Column>
    </PageContainer>
  );
}
