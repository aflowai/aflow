'use client';

import { useMemo, useState } from 'react';
import { Button, Column, Input, Label, Row, Select, Text, Textarea } from '@aflow/design-system';
import { useSaveSimulation } from '../../hooks/use-simulations.js';

/**
 * Authoring a simulation without writing the artifact by hand.
 *
 * Two tiers, and the split is not cosmetic. The top fields are the ones that
 * change what a simulation DOES with no structure to get wrong — the domain
 * brief the generator reasons in, and the two levers over cost and determinism.
 * The structured parts stay JSON because a form over them would be a schema
 * editor, a JSON-pointer editor and a graph editor, and shipping a bad version
 * of those would make the artifact harder to author than the text it replaces.
 *
 * The whole artifact is sent on save. A partial write cannot be validated: an
 * effect names collections and a rule names a status class the definition must
 * declare, so half an artifact is not a smaller one.
 */

/** The parts a form can safely own, split from the parts it cannot. */
const STRUCTURED_KEYS = ['collections', 'ruleProfiles', 'effects', 'personas'] as const;

/** The artifact as this form reads it — everything else is carried through. */
interface SimulationSource {
  name?: unknown;
  description?: unknown;
  domainBrief?: unknown;
  defaultPersonaId?: unknown;
  disclosePersona?: unknown;
  policy?: unknown;
  /** Store-assigned. Sent back as `expectedRevision`, never as part of the artifact. */
  revision?: unknown;
}

/**
 * A text field's value, or empty when the stored value is not text. Coercing a
 * nested object here would put "[object Object]" in the box and then save it.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** The two policy fields this form owns; the rest is carried through unread. */
interface PolicyFields {
  unmatched?: unknown;
  maxGeneratedCallsPerRun?: unknown;
}

function policyOf(simulation: Record<string, unknown>): Record<string, unknown> {
  const policy = (simulation as SimulationSource).policy;
  return typeof policy === 'object' && policy !== null && !Array.isArray(policy)
    ? (policy as Record<string, unknown>)
    : {};
}

interface Draft {
  name: string;
  description: string;
  domainBrief: string;
  defaultPersonaId: string;
  disclosePersona: boolean;
  unmatched: 'generate' | 'error';
  maxGeneratedCallsPerRun: string;
  structured: string;
}

function toDraft(simulation: Record<string, unknown>): Draft {
  const policy = policyOf(simulation) as PolicyFields;
  const source = simulation as SimulationSource;
  const structured = Object.fromEntries(STRUCTURED_KEYS.map((key) => [key, simulation[key]]));
  return {
    name: asText(source.name),
    description: asText(source.description),
    domainBrief: asText(source.domainBrief),
    defaultPersonaId: asText(source.defaultPersonaId),
    disclosePersona: source.disclosePersona === true,
    unmatched: policy.unmatched === 'error' ? 'error' : 'generate',
    maxGeneratedCallsPerRun: asText(policy.maxGeneratedCallsPerRun) || '20',
    structured: JSON.stringify(structured, null, 2),
  };
}

export function SimulationEditor({
  spaceId,
  simulationId,
  simulation,
  onSaved,
}: {
  spaceId: string;
  simulationId: string;
  simulation: Record<string, unknown>;
  onSaved: () => void;
}) {
  const initial = useMemo(() => toDraft(simulation), [simulation]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useSaveSimulation(spaceId, simulationId);

  const dirty = useMemo(
    () => (Object.keys(initial) as Array<keyof Draft>).some((key) => draft[key] !== initial[key]),
    [draft, initial],
  );

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setProblem(null);
  };

  const onSave = (): void => {
    const source = simulation as SimulationSource;
    let structured: Record<string, unknown>;
    try {
      structured = JSON.parse(draft.structured) as Record<string, unknown>;
    } catch (error) {
      setProblem(`The structured half is not valid JSON: ${(error as Error).message}`);
      return;
    }

    const calls = Number(draft.maxGeneratedCallsPerRun);
    if (!Number.isInteger(calls) || calls < 0) {
      setProblem('The generation ceiling must be a whole number of calls.');
      return;
    }

    const policy = {
      ...policyOf(simulation),
      unmatched: draft.unmatched,
      maxGeneratedCallsPerRun: calls,
    };

    save.mutate(
      {
        // The revision this form loaded. A save landing after an agent edited
        // the same artifact is refused rather than dropping that edit.
        expectedRevision: typeof source.revision === 'number' ? source.revision : 0,
        simulation: {
          ...simulation,
          ...structured,
          name: draft.name,
          // An empty description is the absence of one, not a stored blank.
          ...(draft.description.trim().length > 0 ? { description: draft.description } : {}),
          domainBrief: draft.domainBrief,
          ...(draft.defaultPersonaId.trim().length > 0
            ? { defaultPersonaId: draft.defaultPersonaId.trim() }
            : {}),
          disclosePersona: draft.disclosePersona,
          policy,
        },
      },
      {
        onSuccess: () => {
          setProblem(null);
          onSaved();
        },
        onError: (error) => {
          setProblem(error.message);
        },
      },
    );
  };

  return (
    <Column gap="3">
      <Column gap="1">
        <Label htmlFor="sim-name">Name</Label>
        <Input
          id="sim-name"
          value={draft.name}
          onChange={(event) => {
            set('name', event.target.value);
          }}
        />
      </Column>

      <Column gap="1">
        <Label htmlFor="sim-description">Description</Label>
        <Input
          id="sim-description"
          value={draft.description}
          onChange={(event) => {
            set('description', event.target.value);
          }}
        />
      </Column>

      <Column gap="1">
        <Label htmlFor="sim-brief">Domain brief</Label>
        <Text size="xs" color="secondary">
          The world every generated answer has to be plausible in. Who the caller is belongs in a
          persona, not here — this describes the world, not whose corner of it you are standing in.
        </Text>
        <Textarea
          id="sim-brief"
          rows={6}
          value={draft.domainBrief}
          onChange={(event) => {
            set('domainBrief', event.target.value);
          }}
        />
      </Column>

      <Column gap="1">
        <Label htmlFor="sim-default-persona">Acts as</Label>
        <Text size="xs" color="secondary">
          The persona a run takes when it names none. Every collection declaring a{' '}
          <code>personaField</code> is narrowed to it, so an endpoint returns only this
          caller&apos;s rows even when its effect asks for all of them. Leave empty to act as nobody
          — the unauthenticated caller, which reads those collections empty.
        </Text>
        <Input
          id="sim-default-persona"
          value={draft.defaultPersonaId}
          placeholder="none"
          onChange={(event) => {
            set('defaultPersonaId', event.target.value);
          }}
        />
      </Column>

      <Column gap="1">
        <Label htmlFor="sim-disclose">Tell the agent who is calling</Label>
        <Text size="xs" color="secondary">
          A property of the surface being simulated, not of the world. An assistant inside an
          authenticated app receives the caller in its session, and one that opens by asking for a
          customer id rehearses a conversation that deployment never has. A phone desk is the
          opposite, and having to establish identity is a scenario worth testing. The agent is told
          the caller&apos;s name — never their history, and never that this integration is
          simulated.
        </Text>
        <Select
          id="sim-disclose"
          value={draft.disclosePersona ? 'yes' : 'no'}
          onChange={(event) => {
            set('disclosePersona', event.target.value === 'yes');
          }}
        >
          <option value="no">No — the agent has to establish it</option>
          <option value="yes">Yes — the session already knows them</option>
        </Select>
      </Column>

      <Row gap="3" wrap align="end">
        <Column gap="1" style={{ minWidth: 220 }}>
          <Label htmlFor="sim-unmatched">When nothing declared answers</Label>
          <Select
            id="sim-unmatched"
            value={draft.unmatched}
            onChange={(event) => {
              set('unmatched', event.target.value === 'error' ? 'error' : 'generate');
            }}
          >
            <option value="generate">Generate an answer</option>
            <option value="error">Fail the call</option>
          </Select>
          <Text size="xs" color="secondary">
            &quot;Fail the call&quot; is what makes a run reproducible: generation is the one rung
            that does not repeat.
          </Text>
        </Column>

        <Column gap="1" style={{ minWidth: 180 }}>
          <Label htmlFor="sim-ceiling">Generated calls per run</Label>
          <Input
            id="sim-ceiling"
            value={draft.maxGeneratedCallsPerRun}
            onChange={(event) => {
              set('maxGeneratedCallsPerRun', event.target.value);
            }}
          />
          <Text size="xs" color="secondary">
            Reaching it fails the call rather than quietly answering from the contract.
          </Text>
        </Column>
      </Row>

      <Column gap="1">
        <Label htmlFor="sim-structured">Collections, personas, rules and effects</Label>
        <Text size="xs" color="secondary">
          Edited as JSON. A collection declares the schema its rows are held to and, optionally, the{' '}
          <code>personaField</code> that says whose they are; a persona is an identity a run can act
          as; an effect says which collections an endpoint reads and writes; a rule answers a
          matched request outright.
        </Text>
        <Textarea
          id="sim-structured"
          rows={18}
          spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
          value={draft.structured}
          onChange={(event) => {
            set('structured', event.target.value);
          }}
        />
      </Column>

      {problem !== null && (
        <Text size="sm" color="secondary">
          {problem}
        </Text>
      )}

      <Row gap="2" align="center">
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={onSave}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setDraft(initial);
            setProblem(null);
          }}
        >
          Discard
        </Button>
        <Text size="xs" color="secondary">
          Saving bumps the revision. Runs already in flight keep the one they pinned.
        </Text>
      </Row>
    </Column>
  );
}
