'use client';

import { useMemo, useState } from 'react';

/**
 * BATCH DETAIL — the selected batch's reading, in its own scrolling pane
 * beside the rail. The order is fixed by what a reader needs first: identity
 * and the stop/pin controls, the metric strip, then the trial rows themselves.
 * Nothing stands between the reader and the trials; only the readings that
 * answer a second question — the scenario breakdown, the baseline comparison,
 * the judge scorecards, the configuration — sit behind a header that states
 * its own headline.
 */
import {
  Accordion,
  Badge,
  Button,
  Column,
  Icon,
  JsonViewer,
  Pressable,
  ProgressRing,
  Row,
  Table,
  Td,
  Text,
  Th,
  Tr,
  type AccordionItemData,
} from '@aflow/design-system';
import type {
  EvalBatchCaseResultView,
  EvalBatchComparison,
  EvalGraduationCandidate,
} from '@aflow/schemas';

import type { ApiError } from '../../lib/query-client.js';
import { JudgeCalibrationBlock } from './JudgeCalibrationBlock.js';
import type { EvalBatchDetailResponse, EvalComparisonResponse } from './evalsApi.js';
import {
  deriveCaseRollup,
  formatCents,
  formatComparisonSubtitle,
  formatDeltaWithInterval,
  formatPct,
} from './evalsDerive.js';
import { NON_TERMINAL } from './evalsStyles.js';

function Score({
  results,
  trialsPerCase,
  live,
}: {
  results: readonly EvalBatchCaseResultView[];
  trialsPerCase: number;
  live: boolean;
}) {
  if (results.length === 0) {
    return (
      <Text size="sm" color="muted">
        {live ? 'Running…' : 'No results'}
      </Text>
    );
  }
  const rollup = deriveCaseRollup(results, trialsPerCase);
  // The denominator is cases that actually carry a pass^k claim. Dividing by
  // every case would let an execution error or an unsound fixture read as a
  // case the agent failed.
  const complete = rollup.filter((row) => row.complete);
  const clean = complete.filter((row) => row.passAllTrials).length;
  const unscored = rollup.length - complete.length;
  return (
    <Row gap="sm" align="center">
      <ProgressRing
        value={complete.length > 0 ? clean / complete.length : 0}
        ariaLabel={`${String(clean)} of ${String(complete.length)} fully scored cases passed every trial`}
      />
      <Text size="xs" color="muted">
        cases passed every trial{live ? ' so far' : ''}
        {unscored > 0 ? ` · ${String(unscored)} not scored` : ''}
      </Text>
    </Row>
  );
}

function ComparisonBlock({
  comparison,
  baselineBatchId,
  graduationCandidates,
}: {
  comparison: EvalBatchComparison;
  baselineBatchId?: string | undefined;
  graduationCandidates: EvalGraduationCandidate[];
}) {
  const excluded = comparison.excluded;
  const exclusionParts = [
    excluded.added.length > 0 ? `${String(excluded.added.length)} added` : null,
    excluded.removed.length > 0 ? `${String(excluded.removed.length)} removed` : null,
    excluded.edited.length > 0 ? `${String(excluded.edited.length)} edited` : null,
    excluded.undecided.length > 0 ? `${String(excluded.undecided.length)} undecided` : null,
    excluded.unresolvedRevisionIds.length > 0
      ? `${String(excluded.unresolvedRevisionIds.length)} unresolved`
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <Column gap="sm">
      <Row gap="sm" align="center" wrap>
        <Text size="xs" weight="semibold" color="muted">
          {baselineBatchId !== undefined
            ? 'Vs pinned baseline (baseline → this batch)'
            : 'Paired comparison (reference → this batch)'}
        </Text>
        <Badge variant="neutral">n={comparison.pairedCases} paired cases</Badge>
        {!comparison.identicalDatasetVersion && (
          <Badge variant="warning">different dataset versions — intersection only</Badge>
        )}
        {!comparison.identicalTrialsPerCase && (
          <Badge variant="warning">
            different trials per case ({comparison.batchA.trialsPerCase} vs{' '}
            {comparison.batchB.trialsPerCase}) — the per-case rates are not like-for-like
          </Badge>
        )}
      </Row>
      {comparison.perCaseSuccess !== undefined && (
        <Text size="sm">
          Passing every trial {formatDeltaWithInterval(comparison.perCaseSuccess)}
        </Text>
      )}
      {comparison.passAny !== undefined && (
        <Text size="sm">
          Passing at least one trial {formatDeltaWithInterval(comparison.passAny)}
        </Text>
      )}
      {comparison.trialPass !== undefined && (
        <Text size="sm">per-trial {formatDeltaWithInterval(comparison.trialPass)}</Text>
      )}
      {comparison.flips.length > 0 && (
        <Column gap="xs">
          <Text size="xs" weight="semibold" color="muted">
            Per-case flips
          </Text>
          {comparison.flips.map((flip) => (
            <Row key={flip.caseRevisionId} gap="sm" align="center" wrap>
              <Badge variant={flip.direction === 'pass_to_fail' ? 'danger' : 'success'}>
                {flip.direction === 'pass_to_fail' ? 'pass → fail' : 'fail → pass'}
              </Badge>
              {flip.finding === 'investigation' && <Badge variant="warning">investigation</Badge>}
              <Text size="xs">{flip.caseTitle ?? flip.caseRevisionId.slice(0, 8)}</Text>
              <Text size="xs" color="muted">
                {flip.scenario} · {flip.tier} · trials {flip.passedTrialsA}→{flip.passedTrialsB}{' '}
                passed
              </Text>
              <Text size="xs" color="muted">
                runs {flip.runIdsB.map((runId) => runId.slice(0, 8)).join(', ')}
              </Text>
            </Row>
          ))}
        </Column>
      )}
      {exclusionParts.length > 0 && (
        <Text size="xs" color="muted">
          Excluded from pairing: {exclusionParts.join(', ')} — listed, never silently dropped.
        </Text>
      )}
      <Text size="xs" color="muted">
        {comparison.uncertaintyNote}
      </Text>
      {graduationCandidates.length > 0 && (
        <Column gap="xs">
          <Text size="xs" weight="semibold" color="muted">
            Cases that now pass every trial — consider moving them to regression (an operator
            case-edit; nothing auto-mutates)
          </Text>
          <Row gap="xs" wrap>
            {graduationCandidates.map((candidate) => (
              <Badge key={candidate.caseRevisionId} variant="success">
                {candidate.caseTitle ?? candidate.caseId.slice(0, 8)}
              </Badge>
            ))}
          </Row>
        </Column>
      )}
    </Column>
  );
}

/** Past this many cases the list is paged rather than scrolled. */
const CASES_PER_PAGE = 25;

function TrialsTable({
  detail,
  selectedTrial,
  onSelectTrial,
}: {
  detail: EvalBatchDetailResponse;
  selectedTrial: { caseRevisionId: string; trial: number } | null;
  onSelectTrial: (caseRevisionId: string, trial: number) => void;
}) {
  const rollup = useMemo(
    () => deriveCaseRollup(detail.caseResults, detail.batch.trialsPerCase),
    [detail.caseResults, detail.batch.trialsPerCase],
  );
  const failingCount = rollup.filter((row) => row.anyFailing).length;
  const [failingOnly, setFailingOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(rollup.filter((row) => row.anyFailing).map((row) => row.caseRevisionId)),
  );

  const visible = failingOnly ? rollup.filter((row) => row.anyFailing) : rollup;
  const pageCount = Math.max(1, Math.ceil(visible.length / CASES_PER_PAGE));
  const current = Math.min(page, pageCount - 1);
  const rows = visible.slice(current * CASES_PER_PAGE, (current + 1) * CASES_PER_PAGE);

  const toggle = (caseRevisionId: string) => {
    const next = new Set(opened);
    if (next.has(caseRevisionId)) next.delete(caseRevisionId);
    else next.add(caseRevisionId);
    setOpened(next);
  };

  return (
    <Column gap="sm">
      <Row gap="sm" align="center" wrap>
        {failingCount > 0 && (
          <Button
            variant={failingOnly ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => {
              setFailingOnly(!failingOnly);
              setPage(0);
            }}
          >
            {failingOnly ? 'Show all' : 'Only what failed'}
          </Button>
        )}
      </Row>

      <div
        style={{
          overflowX: 'auto',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <Table>
          <thead>
            <Tr>
              {['Case', 'Scenario', 'Kind', 'Trials passed', 'Cost'].map((h) => (
                <Th key={h}>{h}</Th>
              ))}
            </Tr>
          </thead>
          <tbody>
            {rows.flatMap((row) => {
              const isOpen = opened.has(row.caseRevisionId);
              const head = (
                <Tr key={row.caseRevisionId}>
                  <Td>
                    <Pressable
                      onClick={() => {
                        toggle(row.caseRevisionId);
                      }}
                      aria-expanded={isOpen}
                      style={{ width: 'auto', gap: 'var(--space-1)' }}
                    >
                      <Icon name={isOpen ? 'caret-down' : 'caret-right'} size="xs" />
                      <Icon
                        name={row.anyFailing ? 'x' : 'check'}
                        size="xs"
                        style={{
                          color: row.anyFailing
                            ? 'var(--color-danger-default)'
                            : 'var(--color-success-default)',
                        }}
                      />
                      <Text size="xs">{row.caseTitle}</Text>
                    </Pressable>
                  </Td>
                  <Td>{row.scenario ?? '—'}</Td>
                  <Td>{row.tier ?? '—'}</Td>
                  <Td>
                    <Text
                      size="xs"
                      {...(row.anyFailing
                        ? { tone: 'danger' as const }
                        : { color: 'muted' as const })}
                    >
                      {row.passed} of {row.total}
                    </Text>
                  </Td>
                  <Td>{formatCents(row.costCents)}</Td>
                </Tr>
              );
              if (!isOpen) return [head];
              return [
                head,
                ...row.trials.map((result) => {
                  const isSelected =
                    selectedTrial !== null &&
                    selectedTrial.caseRevisionId === result.caseRevisionId &&
                    selectedTrial.trial === result.trial;
                  return (
                    <Tr
                      key={`${result.caseRevisionId}-${String(result.trial)}`}
                      muted
                      onClick={() => {
                        onSelectTrial(result.caseRevisionId, result.trial);
                      }}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? 'var(--color-surface-3)' : undefined,
                      }}
                    >
                      <Td>
                        <Text size="xs" color="muted" style={{ paddingLeft: 'var(--space-5)' }}>
                          trial {result.trial}
                        </Text>
                      </Td>
                      <Td colSpan={2}>
                        {result.gradingError !== undefined ? (
                          <Text size="xs" tone="danger">
                            {result.gradingError}
                          </Text>
                        ) : (
                          <Text size="xs" color="muted">
                            open for its attribution
                          </Text>
                        )}
                      </Td>
                      <Td>
                        {result.verdict !== undefined && (
                          <Badge
                            variant={
                              result.verdict === 'pass'
                                ? 'success'
                                : result.verdict === 'fail'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {result.verdict}
                          </Badge>
                        )}
                      </Td>
                      <Td>
                        {result.fractionPassed !== undefined
                          ? `${formatPct(result.fractionPassed)} of checks`
                          : '—'}
                      </Td>
                    </Tr>
                  );
                }),
              ];
            })}
          </tbody>
        </Table>
      </div>

      {pageCount > 1 && (
        <Row gap="sm" align="center">
          <Button
            variant="ghost"
            size="sm"
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            ← Previous
          </Button>
          <Text size="xs" color="muted">
            {current + 1} of {pageCount}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            disabled={current >= pageCount - 1}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            Next →
          </Button>
        </Row>
      )}
    </Column>
  );
}

export function BatchDetail({
  detail,
  baselineBatchId,
  isBaseline,
  comparison,
  comparisonLoading,
  comparisonError,
  selectedTrial,
  onSelectTrial,
  onCancelBatch,
  onPinBaseline,
  onUnpinBaseline,
  cancelPending,
  pinPending,
  unpinPending,
}: {
  detail: EvalBatchDetailResponse;
  baselineBatchId: string | undefined;
  isBaseline: boolean;
  comparison: EvalComparisonResponse | undefined;
  comparisonLoading: boolean;
  comparisonError: ApiError | null;
  selectedTrial: { caseRevisionId: string; trial: number } | null;
  onSelectTrial: (caseRevisionId: string, trial: number) => void;
  onCancelBatch: () => void;
  onPinBaseline: () => void;
  onUnpinBaseline: () => void;
  cancelPending: boolean;
  pinPending: boolean;
  unpinPending: boolean;
}) {
  const batch = detail.batch;
  const live = NON_TERMINAL.has(batch.status);
  const summary = detail.summary;
  const scorecards = detail.judgeScorecards ?? [];
  const manifest = detail.provenanceManifest;

  const items: AccordionItemData[] = [
    {
      id: 'comparison',
      title: 'Baseline comparison',
      subtitle: formatComparisonSubtitle({
        terminal: !live,
        isBaseline,
        baselinePinned: baselineBatchId !== undefined,
        delta: detail.baselineDelta,
      }),
      children: live ? (
        <Text size="sm" color="muted">
          The comparison reads once the batch is terminal.
        </Text>
      ) : isBaseline ? (
        <Text size="sm" color="muted">
          This batch is the pinned ruler — comparisons read against it.
        </Text>
      ) : baselineBatchId === undefined ? (
        <Text size="xs" color="muted">
          No baseline pinned — pin a completed batch to make comparisons read against a fixed ruler.
        </Text>
      ) : comparison !== undefined ? (
        <ComparisonBlock
          comparison={comparison.comparison}
          baselineBatchId={comparison.baselineBatchId}
          graduationCandidates={comparison.graduationCandidates}
        />
      ) : comparisonLoading ? (
        <Text size="sm" color="muted">
          Loading the comparison…
        </Text>
      ) : comparisonError !== null ? (
        <Text size="xs" color="muted">
          {comparisonError.message}
        </Text>
      ) : null,
    },
    {
      id: 'judges',
      title: 'Judge calibration',
      subtitle:
        scorecards.length > 0
          ? `${String(scorecards.length)} judge scorecard${scorecards.length === 1 ? '' : 's'}`
          : 'no judge scorecards yet',
      children: <JudgeCalibrationBlock scorecards={scorecards} />,
    },
    {
      id: 'provenance',
      title: 'What this run used',
      subtitle: `skill r${String(batch.workflowRevision)} · cases v${String(batch.datasetVersion)} · scorer ${manifest.graderVersion}`,
      children: (
        <Column gap="sm">
          {batch.notes !== undefined && (
            <Text size="xs" color="muted" style={{ fontStyle: 'italic' }}>
              {batch.notes}
            </Text>
          )}
          <Text size="xs" color="muted">
            Skill revision r{batch.workflowRevision} · dataset version v{batch.datasetVersion} ·
            skill config {manifest.workflow.configHash.slice(0, 12)}… · scorer{' '}
            {manifest.graderVersion} · {manifest.subjectModels.length} model
            {manifest.subjectModels.length === 1 ? '' : 's'} (
            {manifest.subjectModels.map((model) => `${model.scope}: ${model.modelRef}`).join(', ')})
            · {Object.keys(manifest.judgeVersions).length} judge version
            {Object.keys(manifest.judgeVersions).length === 1 ? '' : 's'}
          </Text>
          <JsonViewer data={manifest} collapsed={false} collapseDepth={1} copyable />
        </Column>
      ),
    },
  ];

  const defaults = [
    ...(summary !== undefined ? ['result'] : []),
    ...(detail.baselineDelta !== undefined ? ['comparison'] : []),
  ];

  return (
    <Column gap="md" style={{ padding: 'var(--space-4)' }}>
      <Row gap="md" align="center" wrap>
        <Score
          results={detail.caseResults}
          trialsPerCase={detail.batch.trialsPerCase}
          live={live}
        />
        <Text size="xs" color="muted">
          {formatCents(batch.costSpentCents)} of {formatCents(batch.costCeilingCents)}
        </Text>
        <Row gap="xs" style={{ marginLeft: 'auto' }}>
          {live && (
            <Button variant="ghost" size="sm" onClick={onCancelBatch} disabled={cancelPending}>
              Cancel batch
            </Button>
          )}
          {batch.status === 'completed' && !isBaseline && (
            <Button variant="ghost" size="sm" onClick={onPinBaseline} disabled={pinPending}>
              Pin as baseline
            </Button>
          )}
          {isBaseline && (
            <Button variant="ghost" size="sm" onClick={onUnpinBaseline} disabled={unpinPending}>
              Unpin baseline
            </Button>
          )}
        </Row>
      </Row>

      {summary?.terminalReason !== undefined && (
        <Text size="xs" tone="warning">
          Terminalized abnormally: {summary.terminalReason}
        </Text>
      )}

      <Column gap="xs">
        {detail.caseResults.length === 0 ? (
          <Text size="sm" color="muted">
            No trial rows recorded yet.
          </Text>
        ) : (
          <TrialsTable
            detail={detail}
            selectedTrial={selectedTrial}
            onSelectTrial={onSelectTrial}
          />
        )}
      </Column>

      <Accordion multiple items={items} defaultExpanded={defaults} />
    </Column>
  );
}
