'use client';

import { useParams } from 'next/navigation';
import { AppPageHeader } from '../components/app-page-header.js';
import { useNavigation } from '../components/navigation-provider.js';
import {
  Column,
  Row,
  Text,
  Heading,
  Button,
  Badge,
  Icon,
  Divider,
  KeyValueTable,
  PageContainer,
  EmptyState,
  Grid,
  IconButton,
  useBreakpoint,
} from '@aflow/design-system';
import { FlowCanvas } from '../components/agent-editor/FlowCanvas.js';
import type { AgentDefinition } from '../lib/flow-to-graph.js';
import { validateFlow } from '../lib/flow-validation.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { NotInThisSpace } from '../components/not-in-this-space.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** No-op callback for read-only flow canvas. */
const noop = (): void => {
  /* intentionally empty */
};

interface FlowDetail {
  agentId: string;
  slug?: string;
  name: string;
  description?: string;
  latestVersion: string;
  definition: AgentDefinition;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { push } = useNavigation();
  const routeSpace = useSpaceFromRoute();
  const { isMobile } = useBreakpoint();
  const spaceSlug = routeSpace?.slug;

  const {
    data: flow,
    isLoading,
    error: queryError,
  } = useApiQuery<FlowDetail>({
    key: ['space', routeSpace?.id ?? '', 'agents', agentId],
    path: `/agents/${encodeURIComponent(agentId)}`,
    ...(routeSpace?.id ? { spaceId: routeSpace.id } : {}),
    enabled: !!routeSpace?.id,
    staleTime: 60_000,
  });

  const error = queryError
    ? queryError.status === 404
      ? 'Flow not found'
      : queryError.message
    : null;

  // Still resolving the route slug against the user's spaces list, or
  // the query is in flight. Either way, render a clean shell rather
  // than the not-found state.
  if (!routeSpace || isLoading) {
    return (
      <>
        <AppPageHeader title="" />
        <PageContainer>{null}</PageContainer>
      </>
    );
  }

  if (error || !flow) {
    if (queryError?.status === 404 && spaceSlug) {
      return (
        <>
          <AppPageHeader title="Agent" />
          <PageContainer>
            <NotInThisSpace
              resourceKind="agent"
              resourceSlug={agentId}
              currentSpaceSlug={spaceSlug}
            />
          </PageContainer>
        </>
      );
    }
    return (
      <>
        <AppPageHeader title="Agent" />
        <PageContainer>
          <EmptyState
            icon={<Icon name="git-branch" size={48} weight="thin" />}
            title="Agent not found"
            description={error ?? 'The requested agent could not be loaded.'}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  push(spaceRoute(spaceSlug, '/agents'));
                }}
              >
                Back to agents
              </Button>
            }
          />
        </PageContainer>
      </>
    );
  }

  const def = flow.definition;
  const validation = validateFlow(def);

  return (
    <>
      <AppPageHeader
        title={flow.name}
        actions={
          <Row gap="2">
            {isMobile ? (
              <>
                <IconButton
                  icon={<Icon name="clock" size="sm" />}
                  size="sm"
                  variant="ghost"
                  aria-label="Sessions"
                  onClick={() => {
                    push(
                      spaceRoute(
                        spaceSlug,
                        `/sessions?agentId=${encodeURIComponent(flow.agentId)}`,
                      ),
                    );
                  }}
                />
                <IconButton
                  icon={<Icon name="play" size="sm" />}
                  size="sm"
                  variant="ghost"
                  aria-label="Run"
                  onClick={() => {
                    push(
                      spaceRoute(spaceSlug, `/chat?agentId=${encodeURIComponent(flow.agentId)}`),
                    );
                  }}
                />
                <IconButton
                  icon={<Icon name="pencil" size="sm" />}
                  size="sm"
                  variant="primary"
                  aria-label="Edit"
                  onClick={() => {
                    push(
                      spaceRoute(
                        spaceSlug,
                        `/agents/${encodeURIComponent(flow.slug ?? flow.agentId)}/edit`,
                      ),
                    );
                  }}
                />
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="clock" size="xs" />}
                  onClick={() => {
                    push(
                      spaceRoute(
                        spaceSlug,
                        `/sessions?agentId=${encodeURIComponent(flow.agentId)}`,
                      ),
                    );
                  }}
                >
                  Sessions
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="play" size="xs" />}
                  onClick={() => {
                    push(
                      spaceRoute(spaceSlug, `/chat?agentId=${encodeURIComponent(flow.agentId)}`),
                    );
                  }}
                >
                  Run
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Icon name="pencil" size="xs" />}
                  onClick={() => {
                    push(
                      spaceRoute(
                        spaceSlug,
                        `/agents/${encodeURIComponent(flow.slug ?? flow.agentId)}/edit`,
                      ),
                    );
                  }}
                >
                  Edit
                </Button>
              </>
            )}
          </Row>
        }
      />

      <PageContainer>
        <Column gap="6">
          {/* Summary */}
          <Column gap="3">
            {flow.description && <Text variant="muted">{flow.description}</Text>}
            <KeyValueTable
              items={[
                { key: 'Agent ID', value: flow.agentId },
                { key: 'Version', value: flow.latestVersion },
                { key: 'Steps', value: String(def.steps?.length ?? 0) },
                { key: 'Variables', value: String(def.stateVariables?.length ?? 0) },
                { key: 'Status', value: def.status ?? 'published' },
                { key: 'Created', value: new Date(flow.createdAt).toLocaleString() },
              ]}
            />
          </Column>

          <Divider />

          {/* Flow graph preview */}
          {def?.steps && def.steps.length > 0 && (
            <Column gap="3">
              <Heading level={5}>Flow Graph</Heading>
              <div
                style={{
                  height: isMobile ? 280 : 400,
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--color-border-subtle)',
                  overflow: 'hidden',
                }}
              >
                <FlowCanvas
                  flow={def}
                  validation={validation}
                  selectedStepId={null}
                  selectedEdgeId={null}
                  onSelectStep={noop}
                  onSelectEdge={noop}
                  onAddTransition={noop}
                  editable={false}
                />
              </div>
            </Column>
          )}

          {/* Variables */}
          {def?.stateVariables && def.stateVariables.length > 0 && (
            <>
              <Divider />
              <Column gap="3">
                <Heading level={5}>State Variables</Heading>
                <Grid minChildWidth="250px" gap="3">
                  {def.stateVariables.map((v) => (
                    <div
                      key={v.variableId}
                      style={{
                        padding: 'var(--space-3)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--color-border-subtle)',
                      }}
                    >
                      <Column gap="1">
                        <Row gap="2" align="center">
                          <Text variant="mono" size="sm" style={{ fontWeight: 500 }}>
                            {v.variableId}
                          </Text>
                          <Badge variant="info" style={{ fontSize: '9px' }}>
                            {v.semanticType}
                          </Badge>
                        </Row>
                        <Text variant="muted" size="xs">
                          {v.name}
                        </Text>
                        {v.description && (
                          <Text variant="muted" size="xs">
                            {v.description}
                          </Text>
                        )}
                      </Column>
                    </div>
                  ))}
                </Grid>
              </Column>
            </>
          )}

          {/* Validation */}
          {validation && validation.issues.length > 0 && (
            <>
              <Divider />
              <Column gap="3">
                <Heading level={5}>Validation</Heading>
                {validation.issues.map((issue, i) => (
                  <Row key={i} gap="2" align="center">
                    <Badge variant={issue.level === 'error' ? 'failed' : 'paused'}>
                      {issue.level}
                    </Badge>
                    <Text variant="mono" size="sm">
                      {issue.path}
                    </Text>
                    <Text size="sm">{issue.message}</Text>
                  </Row>
                ))}
              </Column>
            </>
          )}
        </Column>
      </PageContainer>
    </>
  );
}
