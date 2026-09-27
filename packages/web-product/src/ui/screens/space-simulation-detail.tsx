'use client';

import { Suspense, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppPageHeader } from '../components/app-page-header.js';
import {
  Badge,
  Button,
  Column,
  EmptyState,
  Icon,
  PageContainer,
  Row,
  Text,
  Tooltip,
} from '@aflow/design-system';
import { useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { SimulationEditor } from '../components/integrations-api/SimulationEditor.js';
import { BaselinePanel } from '../components/integrations-api/BaselinePanel.js';
import { RehearsePanel } from '../components/integrations-api/RehearsePanel.js';
import {
  alwaysGenerates,
  describeAnswerSource,
  useSimulation,
  useSimulationRuns,
  useSimulationWorld,
  type SimulationEndpointReport,
  type SimulationRunSummary,
} from '../hooks/use-simulations.js';

/**
 * The world a run left behind, and what the simulation could answer with.
 *
 * This is the surface that makes a simulated run diagnosable: an agent said
 * something wrong, and the question is whether the world it read said that too.
 * Reading the response alone cannot separate a bad answer from a bad world.
 */

function shortRun(runId: string): string {
  return runId.slice(0, 8);
}

function EndpointRow({ report }: { report: SimulationEndpointReport }) {
  const variant =
    report.readiness === 'world_ready'
      ? 'success'
      : report.readiness === 'contract_ready'
        ? 'info'
        : 'warning';
  return (
    <Row gap="2" align="center" wrap>
      <Badge variant={variant}>{report.readiness.replace('_', ' ')}</Badge>
      <Text size="sm" weight="medium" style={{ minWidth: 0, flex: 1 }} truncate>
        {report.endpointId}
      </Text>
      <Text size="xs" color="secondary">
        {describeAnswerSource(report)}
      </Text>
      {report.diagnostics.length > 0 && (
        <Tooltip content={report.diagnostics.map((d) => d.detail).join(' ')}>
          <Icon name="warning-circle" size="xs" />
        </Tooltip>
      )}
    </Row>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: SimulationRunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Row gap="2" align="center" wrap>
      <Button variant={selected ? 'primary' : 'secondary'} onClick={onSelect}>
        {shortRun(run.runId)}
      </Button>
      <Text size="xs" color="secondary" style={{ minWidth: 0, flex: 1 }} truncate>
        {new Date(run.pinnedAt).toLocaleString()}
      </Text>
      <Tooltip content="Journal records, which is one per call rather than one per write.">
        <Text size="xs" color="secondary">
          {run.callCount} {run.callCount === 1 ? 'call' : 'calls'}
        </Text>
      </Tooltip>
      <Tooltip
        content={`Pinned to baseline ${String(run.baselineVersion)}, simulation revision ${String(run.simulationRevision)}.`}
      >
        <Text size="xs" color="secondary">
          v{run.headVersion}
        </Text>
      </Tooltip>
    </Row>
  );
}

function WorldView({
  spaceId,
  simulationId,
  run,
}: {
  spaceId: string;
  simulationId: string;
  run: SimulationRunSummary;
}) {
  // `undefined` means head. Stepping back re-reads rather than filtering a
  // cached fold: an earlier version is a different fold of the same journal,
  // not a subset of the latest one.
  const [version, setVersion] = useState<number | undefined>(undefined);
  const { world, isLoading, error } = useSimulationWorld(spaceId, simulationId, run.runId, version);

  const shown = world?.worldVersion ?? run.headVersion;

  if (error !== null) {
    return (
      <Row gap="2" align="center">
        <Icon name="warning-circle" size="sm" />
        <Text size="sm" color="secondary">
          {error}
        </Text>
      </Row>
    );
  }

  return (
    <Column gap="3">
      <Row gap="2" align="center" wrap>
        <Text size="sm" weight="medium">
          World at version {shown}
        </Text>
        {world?.atHead === true && <Badge variant="info">head</Badge>}
        <Button
          variant="secondary"
          disabled={shown <= 0}
          onClick={() => {
            setVersion(Math.max(0, shown - 1));
          }}
        >
          ← Earlier
        </Button>
        <Button
          variant="secondary"
          disabled={world?.atHead !== false}
          onClick={() => {
            setVersion(shown + 1 >= run.headVersion ? undefined : shown + 1);
          }}
        >
          Later →
        </Button>
        {version !== undefined && (
          <Button
            variant="secondary"
            onClick={() => {
              setVersion(undefined);
            }}
          >
            Back to head
          </Button>
        )}
      </Row>

      {isLoading && (
        <Text size="sm" color="secondary">
          Folding the journal…
        </Text>
      )}

      {world?.collections.length === 0 && !isLoading && (
        <Text size="sm" color="secondary">
          The world holds no rows at this version.
        </Text>
      )}

      {world?.collections.map((collection) => (
        <Column key={collection.collection} gap="1">
          <Row gap="2" align="center">
            <Text size="sm" weight="medium">
              {collection.collection}
            </Text>
            <Text size="xs" color="secondary">
              {collection.total} {collection.total === 1 ? 'row' : 'rows'}
              {collection.truncated ? ' (truncated)' : ''}
            </Text>
          </Row>
          <div style={{ overflowX: 'auto' }}>
            <pre
              style={{
                margin: 0,
                fontSize: 'var(--font-size-xs)',
                lineHeight: 1.5,
                color: 'var(--color-text-secondary)',
              }}
            >
              {collection.entities.map((entity) => JSON.stringify(entity)).join('\n')}
            </pre>
          </div>
        </Column>
      ))}
    </Column>
  );
}

function SimulationInspector() {
  const params = useParams();
  const router = useRouter();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const simulationId = String(params['simulationId']);

  const { summary, simulation, endpoints, baselines, isLoading, error } = useSimulation(
    spaceId,
    simulationId,
  );

  // The artifact travels as an opaque record, so the two fields the rehearsal
  // needs are read off it here rather than widening the hook's type for a
  // surface that wants exactly two of its forty fields.
  const personas = useMemo(() => {
    const declared = (simulation as { personas?: unknown } | null)?.personas;
    if (!Array.isArray(declared)) return [];
    return declared.filter(
      (persona): persona is { personaId: string; label?: string } =>
        typeof persona === 'object' &&
        persona !== null &&
        typeof (persona as { personaId?: unknown }).personaId === 'string',
    );
  }, [simulation]);
  const defaultPersonaId = ((simulation as { defaultPersonaId?: unknown } | null)
    ?.defaultPersonaId ?? undefined) as string | undefined;
  const domainBrief = ((simulation as { domainBrief?: unknown } | null)?.domainBrief ??
    undefined) as string | undefined;
  const { runs, isLoading: runsLoading } = useSimulationRuns(spaceId, simulationId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // The most recent run is the one someone almost always came here about.
  const selected = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? runs[0],
    [runs, selectedRunId],
  );

  const generatedCount = endpoints.filter(alwaysGenerates).length;

  return (
    <>
      <AppPageHeader title={summary?.name ?? simulationId} />
      <PageContainer>
        <Column gap="4">
          <Row gap="2" align="center" wrap>
            <Button
              variant="secondary"
              onClick={() => {
                router.push(spaceRoute(routeSpace?.slug, '/integrations'));
              }}
            >
              ← Integrations
            </Button>
            {summary && (
              <>
                <Badge variant="info">revision {summary.revision}</Badge>
                <Text size="xs" color="secondary">
                  {summary.targetApiId} · {summary.collections.length} collections
                </Text>
                {generatedCount > 0 && (
                  <Tooltip content="These endpoints declare nothing, so every call to them reaches a model.">
                    <Badge variant="neutral">{generatedCount} always generate</Badge>
                  </Tooltip>
                )}
              </>
            )}
          </Row>

          {error !== null && (
            <Row gap="2" align="center">
              <Icon name="warning-circle" size="sm" />
              <Text size="sm" color="secondary">
                {error}
              </Text>
            </Row>
          )}

          {isLoading && (
            <Text size="sm" color="secondary">
              Loading simulation…
            </Text>
          )}

          {simulation && (
            <Column gap="2">
              <Row gap="2" align="center">
                <Text size="sm" weight="medium">
                  Definition
                </Text>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditing((open) => !open);
                  }}
                >
                  {editing ? 'Close' : 'Edit'}
                </Button>
              </Row>
              {editing && (
                <SimulationEditor
                  spaceId={spaceId}
                  simulationId={simulationId}
                  simulation={simulation}
                  onSaved={() => {
                    setEditing(false);
                  }}
                />
              )}
            </Column>
          )}

          {endpoints.length > 0 && (
            <Column gap="2">
              <Text size="sm" weight="medium">
                Endpoints
              </Text>
              {endpoints.map((report) => (
                <EndpointRow key={report.endpointId} report={report} />
              ))}
            </Column>
          )}

          {simulation && routeSpace?.slug && (
            <RehearsePanel
              spaceId={spaceId}
              spaceSlug={routeSpace.slug}
              simulationId={simulationId}
              domainBrief={domainBrief}
              simulationName={summary?.name ?? undefined}
              personas={personas}
              defaultPersonaId={defaultPersonaId}
              baselines={baselines}
            />
          )}

          {simulation && (
            <BaselinePanel
              spaceId={spaceId}
              simulationId={simulationId}
              baselines={baselines}
              runs={runs}
            />
          )}

          <Column gap="2">
            <Text size="sm" weight="medium">
              Runs
            </Text>
            {runsLoading && (
              <Text size="sm" color="secondary">
                Loading runs…
              </Text>
            )}
            {!runsLoading && runs.length === 0 && (
              <EmptyState
                title="No run has used this simulation yet"
                description="A world exists relative to a run: the space-scoped baseline is what runs start from, and each run keeps its own journal on top of it."
              />
            )}
            {runs.map((run) => (
              <RunRow
                key={run.runId}
                run={run}
                selected={selected?.runId === run.runId}
                onSelect={() => {
                  setSelectedRunId(run.runId);
                }}
              />
            ))}
          </Column>

          {selected && <WorldView spaceId={spaceId} simulationId={simulationId} run={selected} />}
        </Column>
      </PageContainer>
    </>
  );
}

export function SimulationInspectorPage() {
  return (
    <Suspense fallback={null}>
      <SimulationInspector />
    </Suspense>
  );
}
