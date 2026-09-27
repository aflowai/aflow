'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Column, Row, Select, Text } from '@aflow/design-system';
import Link from 'next/link';
import { buildSimulationDeskAgent, type AgentDefinition } from '@aflow/schemas';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { useFlows } from '../../hooks/use-flows.js';
import { spaceRoute } from '../../lib/space-routes.js';
import type { SimulationBaselineSummary } from '../../hooks/use-simulations.js';
import { NOBODY_PERSONA, rehearsalSearchParams } from '../../lib/rehearsal.js';

/**
 * Start a chat against this world, as somebody in it.
 *
 * The pin travels in the LINK rather than in a control on the chat page,
 * because a run's persona, baseline and clock are fixed for the run's life. A
 * chip in the composer would look changeable and would not be — changing it
 * after the first message either does nothing or silently applies to the next
 * session — and a control that lies is worse than none.
 *
 * It also leaves the general chat surface alone. A space with no simulation
 * never renders this, and the chat page reads parameters that are simply not
 * there: no capability check, and so nothing to make fast.
 */

interface Persona {
  personaId: string;
  label?: string;
}

export interface RehearsePanelProps {
  spaceId: string;
  /** Seeds a starter agent's prose. The world's character, never a persona's facts. */
  domainBrief?: string | undefined;
  simulationName?: string | undefined;
  spaceSlug: string;
  simulationId: string;
  personas: Persona[];
  defaultPersonaId?: string | undefined;
  baselines: SimulationBaselineSummary[];
}

export function RehearsePanel({
  spaceId,
  spaceSlug,
  simulationId,
  domainBrief,
  simulationName,
  personas,
  defaultPersonaId,
  baselines,
}: RehearsePanelProps) {
  const router = useRouter();
  const { flows } = useFlows(spaceId);
  const agents = useMemo(() => flows.filter((flow) => !flow.system), [flows]);

  const [agentId, setAgentId] = useState('');
  const [personaId, setPersonaId] = useState(
    defaultPersonaId ?? personas[0]?.personaId ?? NOBODY_PERSONA,
  );
  const [baselineVersion, setBaselineVersion] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const latest = baselines[0]?.version;
  const selectedAgent = agents.find((flow) => flow.agentId === agentId) ?? null;

  const createAgent = useApiMutation<{ definition: AgentDefinition }, { agentId: string }>({
    path: '/agents',
    ...(spaceId ? { spaceId } : {}),
    invalidate: [['space', spaceId, 'agents']],
  });

  /**
   * A desk to talk to, in one step.
   *
   * Everything but the prose is the same for any simulation, so the template
   * writes it and this supplies the two things that are not: which API the
   * agent may call, and what world it is standing in. The prompt is a STARTER —
   * it seeds from the domain brief, which describes the world rather than any
   * caller's account, and is meant to be edited.
   */
  async function createStarterAgent(): Promise<void> {
    setCreating(true);
    setCreateError(null);
    try {
      // "desk" is not appended to either: a simulation called "Customer
      // support desk" produced "cs-desk-desk" / "Customer support desk desk".
      const agent = buildSimulationDeskAgent({
        flowId: `${simulationId}-agent`,
        name: `${simulationName ?? simulationId} agent`,
        description: `Talks to the ${simulationName ?? simulationId} world and nothing else. Starter agent — edit its prompt.`,
        apiId: simulationId,
        systemPrompt: starterPrompt(domainBrief),
        tags: ['simulation', simulationId],
      });
      const created = await createAgent.mutateAsync({
        definition: agent.definition as AgentDefinition,
      });
      setAgentId(created.agentId);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create the agent.');
    } finally {
      setCreating(false);
    }
  }

  function launch(): void {
    const version = Number(baselineVersion);
    const params = rehearsalSearchParams({
      ...(agentId ? { agentId } : {}),
      simulationId,
      personaId: personaId === NOBODY_PERSONA ? null : personaId,
      ...(Number.isInteger(version) && version > 0 ? { baselineVersion: version } : {}),
    });
    router.push(`${spaceRoute(spaceSlug, '/chat')}?${params.toString()}`);
  }

  return (
    <Column gap="2">
      <Text size="sm" weight="medium">
        Rehearse
      </Text>
      <Text size="xs" color="secondary">
        Open a chat against this world as one of the people in it. The persona and the world version
        are fixed for that conversation, and the link carries them — send it to someone and they get
        the same setup.
      </Text>

      <Row gap="2" align="end" wrap>
        <Column gap="1" style={{ minWidth: 220 }}>
          <Text size="xs" color="secondary">
            Agent
          </Text>
          <Select
            id="rehearse-agent"
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value);
            }}
          >
            <option value="">The space&apos;s assistant</option>
            {agents.map((flow) => (
              <option key={flow.agentId} value={flow.agentId}>
                {flow.name}
              </option>
            ))}
          </Select>
        </Column>

        <Column gap="1" style={{ minWidth: 220 }}>
          <Text size="xs" color="secondary">
            Acting as
          </Text>
          <Select
            id="rehearse-persona"
            value={personaId}
            onChange={(event) => {
              setPersonaId(event.target.value);
            }}
          >
            {personas.map((persona) => (
              <option key={persona.personaId} value={persona.personaId}>
                {persona.label ? `${persona.label} — ${persona.personaId}` : persona.personaId}
              </option>
            ))}
            <option value={NOBODY_PERSONA}>Nobody — not signed in</option>
          </Select>
        </Column>

        <Column gap="1" style={{ minWidth: 220 }}>
          <Text size="xs" color="secondary">
            World
          </Text>
          <Select
            id="rehearse-baseline"
            value={baselineVersion}
            onChange={(event) => {
              setBaselineVersion(event.target.value);
            }}
          >
            <option value="">
              {latest === undefined ? 'Latest' : `Latest (v${String(latest)})`}
            </option>
            {baselines.map((baseline) => (
              <option key={baseline.version} value={String(baseline.version)}>
                {baseline.description
                  ? `v${String(baseline.version)} — ${baseline.description}`
                  : `v${String(baseline.version)}`}
              </option>
            ))}
          </Select>
        </Column>

        <Button variant="primary" onClick={launch}>
          Start rehearsal
        </Button>
      </Row>

      <Row gap="2" align="center" wrap>
        <Button
          variant="secondary"
          disabled={creating}
          onClick={() => {
            void createStarterAgent();
          }}
        >
          {creating ? 'Creating…' : 'New agent for this desk'}
        </Button>
        {selectedAgent && spaceSlug && (
          <Link
            href={spaceRoute(
              spaceSlug,
              `/agents/${encodeURIComponent(selectedAgent.slug ?? selectedAgent.agentId)}/edit`,
            )}
            style={{ textDecoration: 'none' }}
          >
            <Text size="xs">Edit {selectedAgent.name} →</Text>
          </Link>
        )}
      </Row>

      {createError && (
        <Text size="xs" color="secondary">
          {createError}
        </Text>
      )}

      {personas.length === 0 && (
        <Text size="xs" color="secondary">
          This simulation declares no personas, so every owned collection reads empty for any
          caller. Add them to the artifact to rehearse as someone who has records.
        </Text>
      )}
    </Column>
  );
}

/**
 * The starting prose for a desk that has none.
 *
 * Short on purpose. The endpoint descriptions and response schemas already
 * carry what a status means, which reference resolves what, and when a human is
 * required — so a prompt that repeats them adds a second copy that drifts. What
 * is left is what a schema cannot say: what this world IS, and the refusal to
 * answer from outside it.
 */
function starterPrompt(domainBrief: string | undefined): string {
  const world = domainBrief?.trim();
  return [
    'You are a support agent for the service described below. Answer from your tools.',
    ...(world ? ['', world] : []),
    '',
    '**Where an answer comes from**, in this order: a tool that answers the question actually asked; then approved guidance for anything about policy or how something works; then, if neither has it, say you do not have a confirmed answer and offer a person.',
    '',
    '**Never invent an answer** — not a plausible one, not an approximate one. An invented answer reaches the customer as fact and they cannot tell you guessed.',
    '',
    '**You already know who you are speaking to.** Their identity comes from the session, so never ask for an account or reference number to identify them.',
    '',
    '**Report what came back.** A call that returned a partial or a refusal has not succeeded, and a date you were not given is not a date you can promise.',
  ].join('\n');
}
