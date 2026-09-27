'use client';

import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Column,
  Heading,
  Icon,
  PageContainer,
  Row,
  SearchField,
  Spinner,
  Text,
} from '@aflow/design-system';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { useAgentModelPolicy, useSetAgentModelPolicy } from '../hooks/use-tenant-governance.js';
import { ErrorRow } from '../components/tenant-settings/policy-controls.js';
import {
  PROVIDER_LABELS,
  formatRate,
  groupByProvider,
  isGroupOpen,
  matchesQuery,
  sortAssignableModels,
  toggleCollapsed,
} from '../components/tenant-settings/modelGroups.js';
import type { CatalogModel } from '../components/tenant-settings/modelGroups.js';

export function TenantModelsPage() {
  const policyQuery = useAgentModelPolicy();
  const setPolicy = useSetAgentModelPolicy();
  const catalogQuery = useApiQuery<{ models: CatalogModel[] }>({
    key: ['catalog', 'models', 'chat'],
    path: '/catalog/models?capability=chat',
    staleTime: 300_000,
  });

  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const assignable = useMemo(
    () => sortAssignableModels(catalogQuery.data?.models ?? []),
    [catalogQuery.data],
  );

  const models = useMemo(
    () => assignable.filter((m) => matchesQuery(m, query)),
    [assignable, query],
  );

  /** The filtered models split into provider groups, order already sorted. */
  const groups = useMemo(() => groupByProvider(models), [models]);

  const enabled = useMemo(() => new Set(policyQuery.data?.modelIds ?? []), [policyQuery.data]);

  const toggleGroup = (provider: string) => {
    setCollapsed((prev) => toggleCollapsed(prev, provider));
  };

  /** A model counts as enabled under any ref the tenant stored for it. */
  const isEnabled = (model: CatalogModel): boolean =>
    enabled.has(model.modelId) || (model.aliases ?? []).some((a) => enabled.has(a));

  const toggle = (model: CatalogModel, next: boolean) => {
    const current = assignable.filter(isEnabled);
    const nextIds = next
      ? [...new Set([...current.map((m) => m.modelId), model.modelId])]
      : current.map((m) => m.modelId).filter((id) => id !== model.modelId);

    // The last model out would leave every role unassignable, so the set is
    // never allowed to empty — clearing back to the platform default is the
    // separate, explicit action below.
    if (nextIds.length === 0) return;
    setPolicy.mutate({ modelIds: nextIds });
  };

  if (policyQuery.isLoading || catalogQuery.isLoading) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Spinner size="lg" label="Loading model settings" />
        </Row>
      </PageContainer>
    );
  }

  const followingPlatform = policyQuery.data?.source === 'platform';
  const searching = query.trim().length > 0;
  // Counted over the whole catalog, not the filtered view: a search that hides
  // the other enabled models must not make the visible one look like the last.
  const enabledCount = assignable.filter(isEnabled).length;
  const visibleEnabledCount = models.filter(isEnabled).length;

  return (
    <PageContainer>
      <Column gap="lg">
        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Models</Heading>
              <Text size="xs" variant="muted">
                Decides which models a space can assign to Helmsman, Runner, Coach, and Judge.
                Narrowing the set blocks new assignments only — a space already running an excluded
                model keeps running until someone changes it.
              </Text>
            </Column>

            {policyQuery.error && <ErrorRow message={policyQuery.error.message} />}
            {catalogQuery.error && <ErrorRow message={catalogQuery.error.message} />}
            {setPolicy.error && <ErrorRow message={setPolicy.error.message} />}

            <Row gap="sm" align="center" wrap>
              <Badge variant={followingPlatform ? 'neutral' : 'info'}>
                {followingPlatform ? 'Following platform recommendations' : 'Custom set'}
              </Badge>
              <Text size="xs" variant="muted">
                {followingPlatform
                  ? 'This set tracks the platform recommendations as they change.'
                  : 'This tenant chose its own set; platform changes will not alter it.'}
              </Text>
              {!followingPlatform && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={setPolicy.isPending}
                  onClick={() => {
                    setPolicy.mutate({ modelIds: null });
                  }}
                >
                  Reset to recommended
                </Button>
              )}
            </Row>
          </Column>
        </section>

        <section>
          <Column gap="md">
            <Row justify="between" align="center" wrap gap="2">
              <Text size="sm" weight="medium">
                {searching ? `${visibleEnabledCount} of ${models.length} shown` : null}
                {searching ? ' · ' : null}
                {enabledCount} of {assignable.length} enabled
              </Text>
              <SearchField
                placeholder="Filter models…"
                value={query}
                onValueChange={setQuery}
                style={{ width: 240 }}
              />
            </Row>

            <Card>
              <CardBody>
                <Column gap="lg">
                  {groups.map(([provider, providerModels]) => {
                    const open = isGroupOpen(provider, collapsed, searching);
                    const onInGroup = providerModels.filter(isEnabled).length;
                    return (
                      <Column key={provider} gap="sm">
                        <button
                          type="button"
                          onClick={() => {
                            toggleGroup(provider);
                          }}
                          aria-expanded={open}
                          disabled={searching}
                          style={{
                            all: 'unset',
                            cursor: searching ? 'default' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--space-1)',
                            paddingBottom: 'var(--space-1)',
                            borderBottom: '1px solid var(--color-border-subtle)',
                          }}
                        >
                          <Icon
                            name={open ? 'caret-down' : 'caret-right'}
                            size="xs"
                            color="var(--color-text-muted)"
                          />
                          <Text size="xs" weight="semibold">
                            {PROVIDER_LABELS[provider] ?? provider}
                          </Text>
                          <Text size="xs" variant="muted">
                            {onInGroup} of {providerModels.length} enabled
                          </Text>
                        </button>
                        {open &&
                          providerModels.map((model) => {
                            const on = isEnabled(model);
                            return (
                              <Row
                                key={model.modelId}
                                gap="sm"
                                align="start"
                                justify="between"
                                style={{ padding: 'var(--space-1) 0' }}
                              >
                                <Column gap="0" style={{ minWidth: 0, flex: 1 }}>
                                  <Row gap="xs" align="center" wrap>
                                    <Text size="sm" weight="medium">
                                      {model.displayName}
                                    </Text>
                                    {model.capabilities.reasoning && (
                                      <Badge variant="neutral">
                                        thinking: {model.reasoning?.supported.join('/') ?? '—'}
                                      </Badge>
                                    )}
                                  </Row>
                                  <Text size="xs" variant="muted">
                                    {formatRate(model.pricing.promptPer1M)} in /{' '}
                                    {formatRate(model.pricing.completionPer1M)} out per 1M ·{' '}
                                    {Math.round(model.contextWindow / 1000)}k context ·{' '}
                                    {model.modelId}
                                  </Text>
                                </Column>
                                <Checkbox
                                  checked={on}
                                  // Every toggle rebuilds the whole set from the loaded
                                  // policy, so a second one issued before the first has
                                  // landed would resend the pre-write set and undo it.
                                  disabled={setPolicy.isPending || (on && enabledCount === 1)}
                                  onChange={(e) => {
                                    toggle(model, e.target.checked);
                                  }}
                                  aria-label={`Enable ${model.displayName}`}
                                />
                              </Row>
                            );
                          })}
                      </Column>
                    );
                  })}
                </Column>
              </CardBody>
            </Card>
          </Column>
        </section>
      </Column>
    </PageContainer>
  );
}
