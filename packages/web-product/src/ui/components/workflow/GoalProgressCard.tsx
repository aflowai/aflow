'use client';

/**
 * Goal progress card — domain-metric view for numeric (threshold) eval
 * criteria, shown for skills that track a target but run no campaigns. (When a
 * skill has campaigns, each campaign renders its own chart in the Campaigns
 * card — one series per campaign — and this standalone card is suppressed.)
 *
 * The Performance tab's aggregate scores answer "is the skill healthy?" but not
 * the operator's actual optimization question: "am I hitting my target?". When
 * the eval suite has a `threshold` criterion (e.g. the Kaggle optimizer's
 * `lbValue > target`) this card plots the raw measured metric against the
 * target so "reached" is visible where the work happens.
 *
 * Data: the target/operator come from the eval suite; the per-run measured
 * values come from each result's matching `CriterionResult.observedValue`
 * (recorded by the threshold grader). Both already live in the evals bundle the
 * Performance tab fetches — no extra round-trip.
 */
import { useMemo } from 'react';
import { Badge, Card, CardBody, Column, Heading, Row, Text } from '@aflow/design-system';
import type { CyberneticEvalSuite, EvalResult, Workflow } from '@aflow/schemas';

import { MetricChart, type MetricChartPoint } from '../graph/MetricChart.js';
import { fmtMetric } from '../graph/metricFormat.js';
import {
  collectThresholds,
  directionOf,
  observedValue,
  operatorSymbol,
  type TrackedThreshold,
} from './goalThresholds.js';

export function GoalProgressCard({
  workflow,
  suite,
  recentResults,
}: {
  workflow: Workflow;
  suite: CyberneticEvalSuite | null;
  recentResults: EvalResult[];
}) {
  const tracked = useMemo<TrackedThreshold[]>(() => collectThresholds(suite), [suite]);
  if (tracked.length === 0) return null;

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Heading level={5}>Goal progress</Heading>
            <Badge variant="info">{workflow.mode}</Badge>
          </Row>
          {workflow.goal && (
            <Text size="sm" variant="muted">
              {workflow.goal}
            </Text>
          )}
          <Column gap="md">
            {tracked.map((t) => (
              <GoalCriterionRow
                key={`${t.tier}-${t.criterion.name}`}
                tracked={t}
                results={recentResults}
              />
            ))}
          </Column>
        </Column>
      </CardBody>
    </Card>
  );
}

interface GoalPoint {
  value: number;
  met: boolean;
  label: string;
  sublabel: string;
}

function GoalCriterionRow({
  tracked,
  results,
}: {
  tracked: TrackedThreshold;
  results: EvalResult[];
}) {
  const c = tracked.criterion;
  const direction = directionOf(c);

  // Results arrive newest-first; reverse to oldest → newest for the chart and
  // keep only graded runs that produced a numeric value for this criterion.
  const points = useMemo<GoalPoint[]>(() => {
    const collected: GoalPoint[] = [];
    const ordered = [...results].reverse();
    ordered.forEach((result, i) => {
      const cr = tracked.pick(result).find((r) => r.criterionName === c.name);
      if (!cr) return;
      const value = observedValue(cr);
      if (value === null) return;
      collected.push({
        value,
        met: cr.passed,
        label: `Run #${String(i + 1)} · ${result.runId.slice(0, 8)}`,
        sublabel: fmtWhen(result.evaluatedAt),
      });
    });
    return collected;
  }, [results, tracked, c.name]);

  const values = points.map((p) => p.value);
  const latest = values[values.length - 1] ?? null;
  const best =
    values.length === 0
      ? null
      : direction === 'maximize'
        ? Math.max(...values)
        : direction === 'minimize'
          ? Math.min(...values)
          : latest;
  const reached = points.some((p) => p.met);

  const chartPoints: MetricChartPoint[] = points.map((p) => ({
    value: p.value,
    met: p.met,
    label: p.label,
    sublabel: p.sublabel,
  }));

  return (
    <Column
      gap="sm"
      style={{
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-2)',
      }}
    >
      <Row gap="sm" align="center" wrap>
        <Badge variant="neutral">{tracked.tier}</Badge>
        <Text size="sm" weight="semibold">
          {c.name}
        </Text>
        <Badge variant="neutral">
          {c.metric} {operatorSymbol(c.operator)} {fmtMetric(c.target)}
          {c.operator === 'between' && c.targetHigh !== undefined
            ? `…${fmtMetric(c.targetHigh)}`
            : ''}
        </Badge>
        {reached ? (
          <Badge variant="success">target reached</Badge>
        ) : (
          <Badge variant="neutral">in progress</Badge>
        )}
      </Row>

      {points.length === 0 ? (
        <Text size="sm" variant="muted">
          No measured <code>{c.metric}</code> yet. Runs plot here once the suite grades this
          criterion with a numeric value.
        </Text>
      ) : (
        <Column gap="md">
          <Row gap="md" wrap>
            <GoalStat label="Best" value={best} highlight={reached} />
            <GoalStat label="Latest" value={latest} />
            <GoalStat label="Target" value={c.target} />
          </Row>
          <MetricChart
            points={chartPoints}
            target={c.target}
            {...(c.targetHigh !== undefined ? { targetHigh: c.targetHigh } : {})}
            direction={direction}
            targetOperator={operatorSymbol(c.operator)}
            metricLabel={c.metric}
            height={200}
            formatValue={fmtMetric}
            ariaLabel={`${c.metric} over ${String(points.length)} runs, target ${fmtMetric(c.target)}, latest ${latest !== null ? fmtMetric(latest) : 'n/a'}`}
          />
        </Column>
      )}
    </Column>
  );
}

function GoalStat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number | null;
  highlight?: boolean;
}) {
  return (
    <Column
      gap="xs"
      style={{
        flex: '0 1 110px',
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        background: highlight ? 'var(--color-success-bg, var(--color-surface-0))' : 'transparent',
      }}
    >
      <Text size="xs" variant="muted">
        {label}
      </Text>
      <Text size="lg" weight="semibold">
        {value === null ? '—' : fmtMetric(value)}
      </Text>
    </Column>
  );
}

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
