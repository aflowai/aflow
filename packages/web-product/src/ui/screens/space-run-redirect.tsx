'use client';

import { useParams } from 'next/navigation';
import { Column, Icon, Row, Spinner, Text } from '@aflow/design-system';
import { useSpace, useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { WorkflowRunSurfaceContainer } from '../components/workflow-run-surface/index.js';

export function RunRedirectPage() {
  const params = useParams();
  const runId = String(params['runId']);
  // The URL is canonical here. `RouteSpaceBridge` syncs the active space in an
  // effect, so on a direct load or a space switch the active one is still the
  // previous space for a render — long enough to fetch a run under it and to
  // point the way back at it.
  const routeSpace = useSpaceFromRoute();
  const { isLoading } = useSpace();
  const spaceId = routeSpace?.id ?? null;
  const spaceSlug = routeSpace?.slugFromRoute;

  return (
    <div style={{ padding: 'var(--space-5)', maxWidth: 820, margin: '0 auto' }}>
      <Column gap="md">
        <Row gap="2" align="center" justify="between" wrap>
          <Row gap="2" align="center">
            <Icon name="lightning" size="md" weight="light" color="var(--color-text-muted)" />
            <Text size="lg" weight="semibold">
              Workflow run
            </Text>
            <Text size="xs" variant="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {runId.slice(0, 8)}
            </Text>
          </Row>
          {spaceSlug && (
            <a
              href={spaceRoute(spaceSlug, '/skills')}
              style={{
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-secondary)',
                textDecoration: 'none',
              }}
            >
              ← Skills
            </a>
          )}
        </Row>

        {!spaceId ? (
          isLoading ? (
            <Row gap="2" align="center" style={{ padding: 'var(--space-6)' }} justify="center">
              <Spinner size="md" label="Loading run" />
            </Row>
          ) : (
            <Text size="sm" variant="muted">
              No active space — open this run from within a space.
            </Text>
          )
        ) : (
          <WorkflowRunSurfaceContainer runId={runId} spaceId={spaceId} />
        )}
      </Column>
    </div>
  );
}
