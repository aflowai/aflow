'use client';

import { useRouter } from 'next/navigation';
import { Badge, Button, Column, Icon, Row, Text, Tooltip } from '@aflow/design-system';
import { useSpaceFromRoute } from '../providers.js';
import { spaceRoute } from '../../lib/space-routes.js';
import {
  alwaysGenerates,
  describeAnswerSource,
  useSimulation,
} from '../../hooks/use-simulations.js';
import type {
  SimulationEndpointReadiness,
  SimulationEndpointReport,
} from '../../hooks/use-simulations.js';

/**
 * What a simulated connection actually answers with, per endpoint.
 *
 * The readiness level and the declared rungs are separate columns because they
 * answer different questions. Readiness says whether the endpoint can be called
 * at all; the rungs say what is authored for it — and an endpoint with nothing
 * declared reaches a model on every call, which readiness alone never says.
 *
 * Both are static reads of the artifact. Neither predicts the rung a given call
 * takes: a rule matches on args and world state, and an effect whose read
 * misses falls through to generation. Only the journal knows what actually
 * answered.
 */

const READINESS_COPY: Record<SimulationEndpointReadiness, { label: string; hint: string }> = {
  world_ready: {
    label: 'World',
    hint: 'Reads and writes the simulated world. Deterministic, instant, and free.',
  },
  contract_ready: {
    label: 'Contract',
    hint: 'Answerable from its response schema. No world effect compiles for it, so nothing holds its answer to the stored world.',
  },
  not_ready: {
    label: 'Not ready',
    hint: 'Declares no usable response schema, so there is no contract to answer with.',
  },
};

function ReadinessBadge({ readiness }: { readiness: SimulationEndpointReadiness }) {
  const copy = READINESS_COPY[readiness];
  const variant =
    readiness === 'world_ready' ? 'success' : readiness === 'contract_ready' ? 'info' : 'warning';
  return (
    <Tooltip content={copy.hint}>
      <Badge variant={variant}>{copy.label}</Badge>
    </Tooltip>
  );
}

function EndpointRow({ report }: { report: SimulationEndpointReport }) {
  const source = describeAnswerSource(report);
  const generated = alwaysGenerates(report);

  return (
    <Row gap="2" align="center" wrap>
      <ReadinessBadge readiness={report.readiness} />
      <Text size="xs" weight="medium" style={{ minWidth: 0, flex: 1 }} truncate>
        {report.endpointId}
      </Text>
      <Tooltip
        content={
          generated
            ? 'Nothing is declared for this endpoint, so every call reaches a model — seconds and tokens each time. Declare a rule or a world effect to make it deterministic.'
            : 'What is declared for this endpoint. A call still reaches a model when no rule matches, or when an effect’s read finds nothing and its onMissing says to generate.'
        }
      >
        <Text size="xs" color="secondary">
          {source}
        </Text>
      </Tooltip>
      {report.diagnostics.length > 0 && (
        <Tooltip content={report.diagnostics.map((d) => d.detail).join(' ')}>
          <Icon name="warning-circle" size="xs" />
        </Tooltip>
      )}
    </Row>
  );
}

export function SimulationPanel({
  spaceId,
  simulationId,
}: {
  spaceId: string;
  simulationId: string;
}) {
  const router = useRouter();
  const routeSpace = useSpaceFromRoute();
  const { summary, endpoints, isLoading, error } = useSimulation(spaceId, simulationId);

  if (isLoading) {
    return (
      <Text size="xs" color="secondary">
        Loading simulation…
      </Text>
    );
  }

  if (error !== null) {
    return (
      <Row gap="2" align="center">
        <Icon name="warning-circle" size="xs" />
        <Text size="xs" color="secondary">
          {error}
        </Text>
      </Row>
    );
  }

  if (!summary) return null;

  const generatedCount = endpoints.filter(alwaysGenerates).length;

  return (
    <Column gap="2">
      <Row gap="2" align="center" wrap>
        <Icon name="flask" size="xs" />
        <Text size="xs" weight="medium">
          {summary.name}
        </Text>
        <Text size="xs" color="secondary">
          revision {summary.revision}
        </Text>
        {summary.collections.length > 0 && (
          <Tooltip content={`Collections: ${summary.collections.join(', ')}`}>
            <Text size="xs" color="secondary">
              {summary.collections.length} collections
            </Text>
          </Tooltip>
        )}
        {generatedCount > 0 && (
          <Tooltip content="These endpoints declare nothing, so every call to them reaches a model. Declaring a rule or a world effect makes them deterministic and free.">
            <Badge variant="neutral">{generatedCount} always generate</Badge>
          </Tooltip>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            router.push(
              spaceRoute(
                routeSpace?.slug,
                `/integrations/simulations/${encodeURIComponent(simulationId)}`,
              ),
            );
          }}
        >
          Inspect world
        </Button>
      </Row>

      {endpoints.length === 0 ? (
        <Text size="xs" color="secondary">
          The API this simulation targets declares no endpoints.
        </Text>
      ) : (
        <Column gap="1">
          {endpoints.map((report) => (
            <EndpointRow key={report.endpointId} report={report} />
          ))}
        </Column>
      )}
    </Column>
  );
}
