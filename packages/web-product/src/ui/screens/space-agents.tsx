'use client';

import { useState } from 'react';
import { useApiMutation } from '../hooks/useApiQuery.js';
import { AppPageHeader } from '../components/app-page-header.js';
import { useNavigation } from '../components/navigation-provider.js';
import {
  Card,
  CardBody,
  Text,
  Heading,
  Button,
  Badge,
  Row,
  Column,
  Grid,
  Input,
  Icon,
  IconButton,
  PageContainer,
  EmptyState,
  Tooltip,
  useBreakpoint,
} from '@aflow/design-system';
import { useFlows } from '../hooks/use-flows.js';
import { useSpace, useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import type { Flow } from '../lib/types.js';

/** Characters of description shown per card; longer copy is cut with an ellipsis (full text on hover). */
const FLOW_CARD_DESCRIPTION_MAX_LENGTH = 160;
/** Longer limit for the hover tooltip; still capped so pathological strings stay bounded. */
const FLOW_TOOLTIP_DESCRIPTION_MAX_LENGTH = 600;

function flowDescriptionPreview(
  description: string,
  maxLength: number,
): { preview: string; wasTruncated: boolean } {
  if (description.length <= maxLength) {
    return { preview: description, wasTruncated: false };
  }
  const trimmed = description.slice(0, maxLength).trimEnd();
  return { preview: `${trimmed}…`, wasTruncated: true };
}

function FlowCardDescription({ description }: { description: string }) {
  const { preview, wasTruncated } = flowDescriptionPreview(
    description,
    FLOW_CARD_DESCRIPTION_MAX_LENGTH,
  );
  const { preview: tooltipPreview } = flowDescriptionPreview(
    description,
    FLOW_TOOLTIP_DESCRIPTION_MAX_LENGTH,
  );
  const text = (
    <Text variant="muted" size="sm" as="span">
      {preview}
    </Text>
  );
  if (wasTruncated) {
    return (
      <Tooltip content={tooltipPreview} side="top" wrap>
        {text}
      </Tooltip>
    );
  }
  return text;
}

/** Reusable agents content — used both standalone and in space settings tab. */
export function AgentsContent() {
  const { push } = useNavigation();
  const { activeSpace } = useSpace();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const { flows, isLoading, error } = useFlows(spaceId);
  const [searchQuery, setSearchQuery] = useState('');
  const { isMobile } = useBreakpoint();
  const spaceSlug = activeSpace?.slug;

  const filteredFlows = flows.filter((flow) => {
    if (!searchQuery) return true;
    return (
      flow.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      flow.agentId.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  return (
    <PageContainer>
      <Column gap="5">
        <Row justify="between" align="center">
          <Input
            type="search"
            placeholder="Search agents…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
            style={{ flex: 1 }}
          />
          {isMobile ? (
            <Tooltip content="New Agent" side="bottom">
              <IconButton
                icon={<Icon name="plus" size="sm" />}
                aria-label="New Agent"
                variant="primary"
                onClick={() => {
                  push(spaceRoute(spaceSlug, '/agents/new'));
                }}
              />
            </Tooltip>
          ) : (
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size="sm" />}
              onClick={() => {
                push(spaceRoute(spaceSlug, '/agents/new'));
              }}
            >
              New Agent
            </Button>
          )}
        </Row>

        {isLoading ? null : error ? (
          <EmptyState title="Something went wrong" description={error} />
        ) : filteredFlows.length === 0 ? (
          <EmptyState
            icon={<Icon name="git-branch" size={48} weight="thin" />}
            title="No agents found"
            description={
              searchQuery ? 'Try adjusting your search' : 'Create your first agent to get started'
            }
            action={
              !searchQuery ? (
                <Button variant="secondary" leftIcon={<Icon name="plus" size="sm" />}>
                  Create agent
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Grid minChildWidth={isMobile ? '100%' : '300px'} gap="4">
            {filteredFlows.map((flow) => (
              <FlowCard key={flow.agentId} flow={flow} />
            ))}
          </Grid>
        )}
      </Column>
    </PageContainer>
  );
}

export function FlowsPage() {
  return (
    <>
      <AppPageHeader title="Agents" />
      <AgentsContent />
    </>
  );
}

function FlowCard({ flow }: { flow: Flow }) {
  const { push } = useNavigation();
  const { activeSpaceId, activeSpace, spaces } = useSpace();
  const spaceSlug = activeSpace?.slug;
  const isFromOtherSpace = flow.spaceId && flow.spaceId !== activeSpaceId;
  const originSpace = isFromOtherSpace ? spaces.find((s) => s.id === flow.spaceId) : null;
  const linkRef = flow.slug ?? flow.agentId;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const archive = useApiMutation<{ agentId: string }, { agentId: string; archived: true }>({
    path: (i) => `/agents/${encodeURIComponent(i.agentId)}`,
    method: 'DELETE',
    ...(activeSpaceId ? { spaceId: activeSpaceId } : {}),
    invalidate: [['space', activeSpaceId ?? '', 'agents']],
  });

  // A platform agent is not this space's to remove, and one borrowed from
  // another space would be deleted out from under its owner.
  const canDelete = !flow.system && !isFromOtherSpace;

  return (
    <Card
      interactive
      onClick={() => {
        push(spaceRoute(spaceSlug, `/agents/${encodeURIComponent(linkRef)}`));
      }}
    >
      <CardBody>
        <Column gap="3">
          <Row justify="between" align="start">
            <Heading level={5}>{flow.name}</Heading>
            <Row gap="1">
              {flow.system && <Badge variant="info">Platform</Badge>}
              {originSpace && <Badge variant="neutral">{originSpace.name}</Badge>}
            </Row>
          </Row>

          {flow.description && <FlowCardDescription description={flow.description} />}

          <Row justify="between" align="center">
            <Text variant="mono" size="xs" color="muted" truncate style={{ maxWidth: '70%' }}>
              {flow.agentId}
            </Text>
            <Text variant="muted" size="xs">
              v{flow.latestVersion}
            </Text>
          </Row>

          <Row gap="2" wrap>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="play" size="xs" />}
              onClick={(e) => {
                e.stopPropagation();
                push(spaceRoute(spaceSlug, `/chat?agentId=${encodeURIComponent(flow.agentId)}`));
              }}
            >
              Run
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="pencil" size="xs" />}
              onClick={(e) => {
                e.stopPropagation();
                push(spaceRoute(spaceSlug, `/agents/${encodeURIComponent(linkRef)}/edit`));
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="clock" size="xs" />}
              onClick={(e) => {
                e.stopPropagation();
                push(
                  spaceRoute(spaceSlug, `/sessions?agentId=${encodeURIComponent(flow.agentId)}`),
                );
              }}
            >
              Sessions
            </Button>
            {canDelete &&
              (confirmingDelete ? (
                <Row gap="1" align="center">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={archive.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      void archive.mutateAsync({ agentId: flow.agentId }).catch(() => {
                        setConfirmingDelete(false);
                      });
                    }}
                  >
                    {archive.isPending ? 'Deleting…' : 'Confirm'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingDelete(false);
                    }}
                  >
                    Cancel
                  </Button>
                </Row>
              ) : (
                <Tooltip content="Removes it from this space. Past conversations stay readable.">
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<Icon name="trash" size="xs" />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingDelete(true);
                    }}
                  >
                    Delete
                  </Button>
                </Tooltip>
              ))}
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
