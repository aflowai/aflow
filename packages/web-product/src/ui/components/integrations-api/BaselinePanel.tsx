'use client';

import { useState } from 'react';
import { Badge, Button, Column, Input, Row, Select, Text, Textarea } from '@aflow/design-system';
import {
  useFreezeBaseline,
  useRestoreBaseline,
  useSeedBaseline,
  type MintedBaseline,
  type SimulationBaselineSummary,
  type SimulationRunSummary,
} from '../../hooks/use-simulations.js';

/**
 * The three ways a baseline is minted, on one surface because they are one
 * decision: what the next run starts from.
 *
 * Every one of them MINTS a version rather than editing one — a run pins a
 * version for its lifetime, so a world that could be rewritten would move under
 * every run still reading it. That makes each action additive and each one
 * undoable by another: a freeze nobody wanted is answered by restoring the
 * version before it, never by deleting anything.
 */

function describeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, total]) => total > 0);
  if (entries.length === 0) return 'empty';
  return entries.map(([collection, total]) => `${collection} ${String(total)}`).join(' · ');
}

function Outcome({ minted }: { minted: MintedBaseline }) {
  return (
    <Text size="xs" color="secondary">
      Minted version {minted.baseline.version} ({describeCounts(minted.baseline.entityCounts)})
      {minted.foldedCallCount !== undefined
        ? ` from ${String(minted.foldedCallCount)} ${minted.foldedCallCount === 1 ? 'call' : 'calls'}`
        : ''}
      . Runs already pinned to an earlier version keep reading it.
    </Text>
  );
}

export function BaselinePanel({
  spaceId,
  simulationId,
  baselines,
  runs,
}: {
  spaceId: string;
  simulationId: string;
  baselines: SimulationBaselineSummary[];
  runs: SimulationRunSummary[];
}) {
  const [mode, setMode] = useState<'freeze' | 'seed' | 'restore'>('freeze');
  const [runId, setRunId] = useState<string>('');
  const [fromVersion, setFromVersion] = useState<string>('');
  const [entitiesJson, setEntitiesJson] = useState<string>('{}');
  const [description, setDescription] = useState<string>('');
  const [problem, setProblem] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedBaseline | null>(null);

  const freeze = useFreezeBaseline(spaceId, simulationId);
  const seed = useSeedBaseline(spaceId, simulationId);
  const restore = useRestoreBaseline(spaceId, simulationId);
  const pending = freeze.isPending || seed.isPending || restore.isPending;

  // Only a run that pinned a world can be frozen. One that never made a
  // simulated call has no journal, and freezing it would clone the baseline
  // through nothing and call the result that run's world.
  const freezable = runs.filter((run) => run.callCount > 0);
  const selectedRun = freezable.find((run) => run.runId === runId) ?? freezable[0];

  const done = (result: MintedBaseline): void => {
    setMinted(result);
    setProblem(null);
  };
  const failed = (error: Error): void => {
    setProblem(error.message);
    setMinted(null);
  };

  const mint = (): void => {
    setProblem(null);
    setMinted(null);
    const note = description.trim().length > 0 ? { description: description.trim() } : {};

    if (mode === 'freeze') {
      if (!selectedRun) {
        setProblem('No run of this simulation has made a call, so none has a world to promote.');
        return;
      }
      freeze.mutate(
        // The version the run PINNED, not the latest: its journal is a set of
        // deltas onto that world and means nothing applied to another.
        { runId: selectedRun.runId, expectedVersion: selectedRun.baselineVersion, ...note },
        { onSuccess: done, onError: failed },
      );
      return;
    }

    if (mode === 'restore') {
      const version = Number(fromVersion || (baselines[1]?.version ?? baselines[0]?.version));
      if (!Number.isInteger(version) || version < 1) {
        setProblem('Pick the version to restore.');
        return;
      }
      restore.mutate({ fromVersion: version, ...note }, { onSuccess: done, onError: failed });
      return;
    }

    let entities: Record<string, Array<Record<string, unknown>>>;
    try {
      entities = JSON.parse(entitiesJson) as Record<string, Array<Record<string, unknown>>>;
    } catch (error) {
      setProblem(`The world is not valid JSON: ${(error as Error).message}`);
      return;
    }
    seed.mutate({ entities, ...note }, { onSuccess: done, onError: failed });
  };

  return (
    <Column gap="3">
      <Row gap="2" align="center" wrap>
        <Text size="sm" weight="medium">
          Baselines
        </Text>
        {baselines[0] && <Badge variant="info">v{baselines[0].version} is latest</Badge>}
        <Text size="xs" color="secondary">
          What a new run starts from. A version is never rewritten, so every action here mints the
          next one.
        </Text>
      </Row>

      <Column gap="1">
        {baselines.slice(0, 6).map((baseline) => (
          <Row key={baseline.version} gap="2" align="center" wrap>
            <Badge variant={baseline.version === baselines[0]?.version ? 'success' : 'neutral'}>
              v{baseline.version}
            </Badge>
            <Text size="xs" color="secondary" style={{ minWidth: 0, flex: 1 }} truncate>
              {baseline.description ?? describeCounts(baseline.entityCounts)}
            </Text>
            <Text size="xs" color="secondary">
              {new Date(baseline.createdAt).toLocaleString()}
            </Text>
          </Row>
        ))}
      </Column>

      <Row gap="2" align="end" wrap>
        <Column gap="1" style={{ minWidth: 240 }}>
          <Select
            id="baseline-mode"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as 'freeze' | 'seed' | 'restore');
              setProblem(null);
              setMinted(null);
            }}
          >
            <option value="freeze">Freeze a run&apos;s world</option>
            <option value="seed">Load a world from JSON</option>
            <option value="restore">Restore an earlier version</option>
          </Select>
        </Column>
        <Button variant="primary" disabled={pending} onClick={mint}>
          {pending ? 'Minting…' : 'Mint version'}
        </Button>
      </Row>

      {mode === 'freeze' && (
        <Column gap="1">
          <Text size="xs" color="secondary">
            Folds everything a run read, wrote or invented into fixed seed data, so the simulation
            converges from generative to deterministic. Fold a run that has finished — a journal
            still growing yields an arbitrary midpoint.
          </Text>
          {freezable.length === 0 ? (
            <Text size="sm" color="secondary">
              No run of this simulation has made a call yet.
            </Text>
          ) : (
            <Select
              id="baseline-run"
              value={selectedRun?.runId ?? ''}
              onChange={(event) => {
                setRunId(event.target.value);
              }}
            >
              {freezable.map((candidate) => (
                <option key={candidate.runId} value={candidate.runId}>
                  {candidate.runId.slice(0, 8)} · {candidate.callCount} calls · pinned to v
                  {candidate.baselineVersion}
                </option>
              ))}
            </Select>
          )}
        </Column>
      )}

      {mode === 'restore' && (
        <Column gap="1">
          <Text size="xs" color="secondary">
            Undo, in a store where nothing is rewritten: this mints a NEW version holding what the
            chosen one held. Runs pinned to the version being replaced keep reading it, because
            their journals were written against it.
          </Text>
          <Select
            id="baseline-from"
            value={fromVersion || String(baselines[1]?.version ?? baselines[0]?.version ?? '')}
            onChange={(event) => {
              setFromVersion(event.target.value);
            }}
          >
            {baselines.map((baseline) => (
              <option key={baseline.version} value={baseline.version}>
                v{baseline.version} · {describeCounts(baseline.entityCounts)}
              </option>
            ))}
          </Select>
        </Column>
      )}

      {mode === 'seed' && (
        <Column gap="1">
          <Text size="xs" color="secondary">
            One array per declared collection. A collection left out is carried forward from the
            latest version and held to the declarations as they stand now — so one whose schema
            changed since it was seeded has to be supplied again.
          </Text>
          <Textarea
            id="baseline-entities"
            rows={10}
            spellCheck={false}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
            value={entitiesJson}
            onChange={(event) => {
              setEntitiesJson(event.target.value);
            }}
          />
        </Column>
      )}

      <Input
        id="baseline-description"
        placeholder="What this world is for (optional)"
        value={description}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
      />

      {problem !== null && (
        <Text size="sm" color="secondary">
          {problem}
        </Text>
      )}
      {minted !== null && <Outcome minted={minted} />}
    </Column>
  );
}
