'use client';

/**
 * JUDGE CALIBRATION — the judge measured as a classifier (D11) against the
 * operator's own labels, scoped to the batch whose subject configuration
 * produced them. A scorecard measures the judge; it does not change a verdict
 * the judge already decided.
 */
import { Badge, Column, Row, Text } from '@aflow/design-system';
import type { JudgeScorecard, WilsonInterval } from '@aflow/schemas';

import { formatPct } from './evalsDerive.js';

function formatWilson(interval: WilsonInterval | undefined): string {
  if (interval === undefined) return '—';
  return `${formatPct(interval.estimate)} [${formatPct(interval.lower)}, ${formatPct(interval.upper)}] (n=${String(interval.n)})`;
}

function ScorecardRow({ scorecard }: { scorecard: JudgeScorecard }) {
  const kappa = scorecard.kappa;
  const gate = scorecard.gate;
  return (
    <Column
      gap="xs"
      style={{
        padding: 'var(--space-2) var(--space-3)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <Row gap="sm" align="center" wrap>
        <Text size="sm" weight="semibold">
          {scorecard.criterionId}
        </Text>
        <Badge variant="neutral">{scorecard.scopeKey}</Badge>
        <Text size="xs" color="muted">
          judge {scorecard.judgeVersion.slice(0, 12)}… · subjects{' '}
          {scorecard.subjectModels.map((model) => model.modelRef).join(', ')}
        </Text>
      </Row>
      <Row gap="md" wrap>
        <Text size="xs" color="muted">
          Precision {formatWilson(scorecard.precision)}
        </Text>
        <Text size="xs" color="muted">
          Recall {formatWilson(scorecard.recall)}
        </Text>
        <Text size="xs" color="muted">
          TNR {formatWilson(scorecard.tnr)}
        </Text>
        <Text size="xs" color="muted">
          κ{' '}
          {kappa.estimate !== undefined
            ? `${kappa.estimate.toFixed(2)}${
                kappa.lower !== undefined && kappa.upper !== undefined
                  ? ` [${kappa.lower.toFixed(2)}, ${kappa.upper.toFixed(2)}]`
                  : ''
              } (${String(kappa.resamples)} resamples)`
            : 'undefined (degenerate matrix)'}
        </Text>
      </Row>
      <Row gap="sm" align="center" wrap>
        <Text size="xs" color="muted">
          {scorecard.validationLabels} validation label
          {scorecard.validationLabels === 1 ? '' : 's'} · {scorecard.pairedLabels} paired ·{' '}
          {scorecard.unpairedLabels} unpaired
        </Text>
        <Text size="xs" color="muted">
          Trust bar: needs κ ≥ {gate.judgeTrustKappa.toFixed(2)} over ≥{gate.judgeTrustMinLabels}{' '}
          labels
          {gate.labelsShort > 0 ? ` — ${String(gate.labelsShort)} labels short` : ''}
          {gate.kappaLowerBound !== undefined
            ? ` — κ lower bound ${gate.kappaLowerBound.toFixed(2)}`
            : ''}
        </Text>
        <Badge variant={gate.wouldPass ? 'success' : 'neutral'}>
          {gate.wouldPass ? 'would pass' : 'would not pass'}
        </Badge>
      </Row>
    </Column>
  );
}

export function JudgeCalibrationBlock({ scorecards }: { scorecards: JudgeScorecard[] }) {
  return (
    <Column gap="xs">
      {scorecards.length > 0 ? (
        <>
          {scorecards.map((scorecard) => (
            <ScorecardRow
              key={`${scorecard.scopeKey}|${scorecard.criterionId}|${scorecard.judgeVersion}|${scorecard.subjectConfigKey}`}
              scorecard={scorecard}
            />
          ))}
        </>
      ) : (
        <Text size="sm" color="muted">
          Nothing yet. Label trials in Review to build this.
        </Text>
      )}
    </Column>
  );
}
