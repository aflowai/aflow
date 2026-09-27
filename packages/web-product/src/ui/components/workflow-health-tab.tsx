'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Heading,
  Icon,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';
import type {
  CoachLearning,
  CoachObservation,
  CyberneticEvalSuite,
  EvalBaseline,
  EvalQualityReport,
  EvalResult,
  SkillCampaignContract,
  Workflow,
  WorkflowEvalsBundle,
} from '@aflow/schemas';
import { formatCampaignParamForDisplay, formatThresholdOperatorForDisplay } from '@aflow/schemas';

import { MetricChart, type MetricChartPoint } from './graph/MetricChart.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { JudgeCalibrationTab } from './workflow/JudgeCalibrationTab.js';
import { GoalProgressCard } from './workflow/GoalProgressCard.js';
import { CampaignsCard } from './workflow/CampaignsCard.js';

interface ProposalsResponse {
  proposals: Array<{
    id: string;
    kind: string;
    status: string;
    targetWorkflowSlug?: string | null;
  }>;
}

interface ObservationsResponse {
  workflowSlug: string;
  observations: CoachObservation[];
}

interface LearningsResponse {
  workflowSlug: string;
  learnings: CoachLearning[];
}

interface WorkflowHealthTabProps {
  spaceId: string;
  workflowSlug: string;
  /** Parsed workflow doc — supplies mode + goal text for the Goal card. */
  workflow: Workflow;
  /** The skill's campaign contract (from its manifest) — enables the campaign
   *  start/update form when present. */
  campaignContract?: SkillCampaignContract | undefined;
  /** Switch the page to the Proposals tab (operator signals link). */
  onOpenProposals?: (() => void) | undefined;
}

export function WorkflowHealthTab({
  spaceId,
  workflowSlug,
  workflow,
  campaignContract,
  onOpenProposals,
}: WorkflowHealthTabProps) {
  // Shares the `…/evals` cache key with the designer's eval hooks (Plan 161 —
  // server reads route through useApiQuery, not raw fetch).
  const bundleQuery = useApiQuery<WorkflowEvalsBundle>({
    key: ['space', spaceId, 'workflow', workflowSlug, 'evals'],
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/evals`,
    spaceId,
    staleTime: 30_000,
  });
  const bundle = bundleQuery.data ?? null;
  const loading = bundleQuery.isLoading;
  const error = bundleQuery.error?.message ?? null;
  const reload = () => void bundleQuery.refetch();

  const proposalsQuery = useApiQuery<ProposalsResponse>({
    key: ['space', spaceId, 'proposals', { workflowSlug, pendingOnly: true }],
    path: `/spaces/${spaceId}/proposals?workflowSlug=${encodeURIComponent(workflowSlug)}&pendingOnly=true`,
    spaceId,
    staleTime: 30_000,
  });

  const observationsQuery = useApiQuery<ObservationsResponse>({
    key: ['space', spaceId, 'workflow', workflowSlug, 'observations'],
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/observations?limit=20`,
    spaceId,
    staleTime: 30_000,
  });
  const learningsQuery = useApiQuery<LearningsResponse>({
    key: ['space', spaceId, 'workflow', workflowSlug, 'learnings'],
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/learnings?limit=20`,
    spaceId,
    staleTime: 30_000,
  });

  // Whether the skill has any campaigns — decides who owns the goal chart:
  // per-campaign (Campaigns card) vs the standalone Goal-progress card. Shares
  // the Campaigns card's query key/path, so React Query dedupes the request.
  const campaignsCountQuery = useApiQuery<{ campaigns: unknown[] }>({
    key: ['space', spaceId, 'workflow', workflowSlug, 'campaigns'],
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/campaigns?status=all`,
    spaceId,
    staleTime: 30_000,
  });
  const hasCampaigns = (campaignsCountQuery.data?.campaigns.length ?? 0) > 0;

  // Trend series is derived from the recent results; computed before any
  // early returns so hook order stays stable across loading/error states.
  const trendValues = useTrendSeries(bundle?.recentResults ?? null);

  if (loading && !bundle) {
    return (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner size="md" label="Loading evals" />
      </Row>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 'var(--space-5)' }}>
        <Card>
          <CardBody>
            <Column gap="sm">
              <Row gap="sm" align="center">
                <Icon name="warning" size="md" />
                <Heading level={5}>Could not load eval data</Heading>
              </Row>
              <Text size="sm" variant="muted">
                {error}
              </Text>
              <Row>
                <Button variant="secondary" size="sm" onClick={reload}>
                  Retry
                </Button>
              </Row>
            </Column>
          </CardBody>
        </Card>
      </div>
    );
  }

  if (!bundle) return null;

  const { suite, baseline, recentResults, qualityReport } = bundle;
  const proposalsAll = proposalsQuery.data?.proposals ?? [];
  const openProposals = proposalsAll.filter((p) => p.kind !== 'platform_issue');
  const openPlatformIssues = proposalsAll.filter((p) => p.kind === 'platform_issue');
  const observations = observationsQuery.data?.observations ?? [];
  const learnings = learningsQuery.data?.learnings ?? [];

  return (
    <div style={{ padding: 'var(--space-5)', maxWidth: 1200, marginInline: 'auto', width: '100%' }}>
      <Column gap="md">
        {/* Progress → regression → outcomes → learnings → configuration. The
            operator's day-to-day questions (am I hitting my target? is it
            regressing? what happened lately?) rank above the static suite
            definition. */}
        <OperatorSignalsRow
          openProposalCount={openProposals.length}
          openPlatformIssueCount={openPlatformIssues.length}
          onOpenProposals={onOpenProposals}
        />
        {/* Campaigns own the goal chart per campaign; the standalone Goal card
            is for skills that track a target but run no campaigns. */}
        {!hasCampaigns && (
          <GoalProgressCard workflow={workflow} suite={suite} recentResults={recentResults} />
        )}
        <CampaignsCard
          spaceId={spaceId}
          workflowSlug={workflowSlug}
          workflow={workflow}
          suite={suite}
          campaignContract={campaignContract}
        />
        <BaselineCard baseline={baseline} trendValues={trendValues} />
        <ResultsCard results={recentResults} />
        <CoachFeedbackCard observations={observations} learnings={learnings} />
        <SuiteCard suite={suite} qualityReport={qualityReport} />
        <JudgeCriteriaSection suite={suite} spaceId={spaceId} workflowSlug={workflowSlug} />
      </Column>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OperatorSignalsRow({
  openProposalCount,
  openPlatformIssueCount,
  onOpenProposals,
}: {
  openProposalCount: number;
  openPlatformIssueCount: number;
  onOpenProposals?: (() => void) | undefined;
}) {
  return (
    <Card>
      <CardBody>
        {/* Nested in a Column so the chip Row escapes the global
            `.ds-card__body > * { justify-content: space-between }` rule —
            otherwise the chips stretch across the full card width. */}
        <Column gap="sm">
          <Row gap="md" wrap align="center" justify="start">
            <SignalChip
              label="Open proposals"
              value={openProposalCount === 0 ? 'none' : `${String(openProposalCount)} waiting`}
              variant={openProposalCount === 0 ? 'neutral' : 'info'}
            />
            <SignalChip
              label="Blockers"
              value={
                openPlatformIssueCount === 0
                  ? 'none'
                  : `${String(openPlatformIssueCount)} platform issue${openPlatformIssueCount === 1 ? '' : 's'}`
              }
              variant={openPlatformIssueCount === 0 ? 'success' : 'danger'}
            />
            {onOpenProposals && (
              <Button variant="ghost" size="sm" onClick={onOpenProposals}>
                View proposals →
              </Button>
            )}
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}

function SignalChip({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
}) {
  return (
    <Row gap="xs" align="center">
      <Text size="xs" variant="muted">
        {label}
      </Text>
      <Badge variant={variant}>{value}</Badge>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Suite card
// ---------------------------------------------------------------------------

function SuiteCard({
  suite,
  qualityReport,
}: {
  suite: CyberneticEvalSuite | null;
  qualityReport: EvalQualityReport | null;
}) {
  if (!suite) {
    return (
      <Card>
        <CardBody>
          <Column gap="sm">
            <Heading level={5}>Eval suite</Heading>
            <Text size="sm" variant="muted">
              No suite yet — a valid state. The Coach authors one when run evidence warrants it;
              criteria can also be added from the designer&apos;s eval editor.
            </Text>
          </Column>
        </CardBody>
      </Card>
    );
  }

  const goalCount = suite.goalCriteria.length;
  const trajCount = suite.trajectoryCriteria.length;
  const taskTotal = Object.values(suite.taskCriteria).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Heading level={5}>Eval suite</Heading>
            {suite.judgeSamplingRate !== undefined && suite.judgeSamplingRate < 1 && (
              <Badge variant="neutral">
                judge rate {(suite.judgeSamplingRate * 100).toFixed(0)}%
              </Badge>
            )}
          </Row>

          <Row gap="md" wrap>
            <Tier icon="flag" label="Goal criteria" count={goalCount} weight={suite.weights.goal} />
            <Tier
              icon="list"
              label="Task criteria"
              count={taskTotal}
              weight={suite.weights.task}
              hint={`${String(Object.keys(suite.taskCriteria).length)} task(s)`}
            />
            <Tier
              icon="git-branch"
              label="Trajectory"
              count={trajCount}
              weight={suite.weights.trajectory}
            />
          </Row>

          {(goalCount > 0 || trajCount > 0 || taskTotal > 0) && (
            <CriteriaList suite={suite} qualityReport={qualityReport} />
          )}

          <Column gap="xs">
            <Text size="xs" variant="muted">
              Updated {formatDateTime(suite.updatedAt)} by {suite.createdBy}
            </Text>
          </Column>
        </Column>
      </CardBody>
    </Card>
  );
}

function CriteriaList({
  suite,
  qualityReport,
}: {
  suite: CyberneticEvalSuite;
  qualityReport: EvalQualityReport | null;
}) {
  const goalEntries = suite.goalCriteria.map((c, i) => ({
    tier: 'Goal' as const,
    reportTier: 'goal',
    index: i,
    c,
  }));
  const trajEntries = suite.trajectoryCriteria.map((c, i) => ({
    tier: 'Trajectory' as const,
    reportTier: 'trajectory',
    index: i,
    c,
  }));
  const taskEntries = Object.entries(suite.taskCriteria).flatMap(([taskId, criteria]) =>
    criteria.map((c, i) => ({
      tier: `Task: ${taskId}` as const,
      reportTier: `task:${taskId}`,
      index: i,
      c,
    })),
  );
  const all = [...goalEntries, ...taskEntries, ...trajEntries];
  if (all.length === 0) return null;

  const flagged = new Map(
    (qualityReport?.criteria ?? [])
      .filter((stat) => stat.alwaysPasses)
      .map((stat) => [`${stat.tier} ${stat.name}`, stat.samples] as const),
  );

  return (
    <Column gap="xs">
      <Text size="xs" weight="semibold" variant="muted">
        Criteria
      </Text>
      <Column gap="xs">
        {all.map(({ tier, reportTier, index, c }) => (
          <CriterionRow
            key={`${tier}-${String(index)}-${c.name}`}
            tier={tier}
            criterion={c}
            alwaysPassesSamples={flagged.get(`${reportTier} ${c.name}`)}
          />
        ))}
      </Column>
    </Column>
  );
}

function CriterionRow({
  tier,
  criterion,
  alwaysPassesSamples,
}: {
  tier: string;
  criterion: CyberneticEvalSuite['goalCriteria'][number];
  alwaysPassesSamples?: number | undefined;
}) {
  // Most operator-relevant: the evaluator type.
  const typeVariant: 'success' | 'warning' | 'danger' | 'neutral' | 'info' =
    criterion.type === 'judge' ? 'info' : 'neutral';
  const detail = describeCriterion(criterion);
  return (
    <Row
      gap="sm"
      align="center"
      wrap
      style={{
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-2)',
      }}
    >
      <Badge variant="neutral">{tier}</Badge>
      <Text size="sm" weight="semibold">
        {criterion.name}
      </Text>
      <Badge variant={typeVariant}>{criterion.type}</Badge>
      {alwaysPassesSamples !== undefined && (
        <Badge variant="warning">always passes (n={String(alwaysPassesSamples)})</Badge>
      )}
      {detail && (
        <Text size="xs" variant="muted" style={{ flex: '1 1 200px' }}>
          {detail}
        </Text>
      )}
    </Row>
  );
}

function describeCriterion(c: CyberneticEvalSuite['goalCriteria'][number]): string | null {
  switch (c.type) {
    case 'threshold':
      return `${c.metric} ${formatThresholdOperatorForDisplay(c.operator)} ${formatCampaignParamForDisplay(c.target)}${c.targetHigh !== undefined ? '…' + String(c.targetHigh) : ''}`;
    case 'contains': {
      // Field is `inField` on the schema. Some operator-authored suites
      // omit it; flag the gap rather than render "undefined contains …".
      const field = c.inField && c.inField.length > 0 ? c.inField : null;
      const target = field ?? '(no field set — criterion will not resolve)';
      return `${target} contains "${c.pattern}"`;
    }
    case 'judge':
      return `LLM judge · ${String(c.rubric.length)} rubric entries`;
    case 'trace_bound':
      return `trace constraint`;
    default:
      return null;
  }
}

function Tier({
  icon,
  label,
  count,
  weight,
  hint,
}: {
  icon: 'flag' | 'list' | 'git-branch';
  label: string;
  count: number;
  weight: number;
  hint?: string;
}) {
  return (
    <Column
      gap="xs"
      style={{
        flex: '1 1 180px',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-2)',
      }}
    >
      <Row gap="xs" align="center">
        <Icon name={icon} size="sm" />
        <Text size="xs" weight="semibold">
          {label}
        </Text>
      </Row>
      <Text size="lg" weight="semibold">
        {count}
      </Text>
      <Text size="xs" variant="muted">
        weight {(weight * 100).toFixed(0)}%{hint ? ` · ${hint}` : ''}
      </Text>
    </Column>
  );
}

// ---------------------------------------------------------------------------
// Judge criteria section (104e Phase 2.5)
// ---------------------------------------------------------------------------

interface JudgeCriteriaSectionProps {
  suite: CyberneticEvalSuite | null;
  spaceId: string;
  workflowSlug: string;
}

function JudgeCriteriaSection({ suite, spaceId, workflowSlug }: JudgeCriteriaSectionProps) {
  if (!suite) return null;

  const evalSuitePath = `/evals/${workflowSlug}/suite.json`;

  // Collect all judge criteria with their scope
  const judgeCriteria: Array<{
    name: string;
    scope: 'goal' | 'trajectory' | { task: string };
  }> = [];

  for (const c of suite.goalCriteria) {
    if (c.type === 'judge') judgeCriteria.push({ name: c.name, scope: 'goal' });
  }
  for (const [taskId, criteria] of Object.entries(suite.taskCriteria)) {
    for (const c of criteria) {
      if (c.type === 'judge') judgeCriteria.push({ name: c.name, scope: { task: taskId } });
    }
  }
  for (const c of suite.trajectoryCriteria) {
    if (c.type === 'judge') judgeCriteria.push({ name: c.name, scope: 'trajectory' });
  }

  if (judgeCriteria.length === 0) return null;

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Heading level={5}>Judge calibration</Heading>
            <Badge variant="neutral">{String(judgeCriteria.length)} judge criteria</Badge>
          </Row>
          <Text size="sm" variant="muted">
            A judge decides its criterion, so a trial can fail on one alone. Recording your own
            verdict on a run is what says whether it decides the way a person would.
          </Text>
          <Column gap="sm">
            {judgeCriteria.map((jc) => (
              <JudgeCalibrationTab
                key={`${jc.name}-${typeof jc.scope === 'string' ? jc.scope : `task:${jc.scope.task}`}`}
                spaceId={spaceId}
                criterionId={jc.name}
                criterionName={jc.name}
                evalSuitePath={evalSuitePath}
                scope={jc.scope}
              />
            ))}
          </Column>
        </Column>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Baseline card
// ---------------------------------------------------------------------------

function BaselineCard({
  baseline,
  trendValues,
}: {
  baseline: EvalBaseline | null;
  trendValues: number[];
}) {
  const inRegression =
    baseline !== null && baseline.currentBreachCount >= baseline.consecutiveBreachesRequired;

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Heading level={5}>Rolling baseline</Heading>
            {baseline === null ? (
              <Badge variant="neutral">no baseline yet</Badge>
            ) : inRegression ? (
              <Badge variant="warning">regression</Badge>
            ) : baseline.currentBreachCount > 0 ? (
              <Badge variant="warning">
                {String(baseline.currentBreachCount)}/{String(baseline.consecutiveBreachesRequired)}{' '}
                breach
                {baseline.currentBreachCount === 1 ? '' : 'es'}
              </Badge>
            ) : (
              <Badge variant="success">healthy</Badge>
            )}
            {baseline && <Badge variant="neutral">n={String(baseline.sampleSize)}</Badge>}
          </Row>

          {baseline ? (
            <>
              <Row gap="md" wrap>
                <Score label="Overall" value={baseline.baselineScores.overall} emphasis />
                <Score label="Goal" value={baseline.baselineScores.goalScore} />
                <Score label="Task" value={baseline.baselineScores.taskScore} />
                <Score label="Trajectory" value={baseline.baselineScores.trajectoryScore} />
              </Row>
              <BaselineTrend baseline={baseline} trendValues={trendValues} />
              <Text size="xs" variant="muted">
                Updated {formatDateTime(baseline.updatedAt)}
              </Text>
            </>
          ) : (
            <Text size="sm" variant="muted">
              The baseline forms after at least 3 successful runs. Run the workflow a few times to
              start tracking regressions.
            </Text>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

/**
 * Overall-score trend for the rolling baseline. Plots the last-N overall scores
 * against the breach floor (the actual regression trigger, `baseline × (1 −
 * threshold)`) so "am I clear of a regression?" reads off the chart. Shares the
 * MetricChart so every chart on the tab looks and behaves the same.
 */
function BaselineTrend({
  baseline,
  trendValues,
}: {
  baseline: EvalBaseline;
  trendValues: number[];
}) {
  const breachFloor = baseline.baselineScores.overall * (1 - baseline.regressionThreshold);
  const points: MetricChartPoint[] = trendValues.map((v, i) => ({
    value: v,
    met: v >= breachFloor,
    label: `#${String(i + 1)}`,
  }));
  return (
    <Column gap="xs">
      <Row gap="sm" align="baseline" wrap>
        <Text size="xs" variant="muted">
          Overall score · last {String(trendValues.length)} run
          {trendValues.length === 1 ? '' : 's'}
        </Text>
        <Text size="xs" variant="muted" style={{ marginLeft: 'auto' }}>
          breach if overall &lt; {breachFloor.toFixed(2)} (baseline ×{' '}
          {(1 - baseline.regressionThreshold).toFixed(2)})
        </Text>
      </Row>
      {trendValues.length > 0 ? (
        <MetricChart
          points={points}
          target={breachFloor}
          direction="maximize"
          referenceLabel="breach"
          metricLabel="overall"
          height={160}
          formatValue={(v) => v.toFixed(2)}
          ariaLabel={`Overall score trend, breach floor ${breachFloor.toFixed(2)}`}
        />
      ) : (
        <Text size="sm" variant="muted">
          The score trend appears after a few graded runs.
        </Text>
      )}
    </Column>
  );
}

function Score({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number | undefined;
  emphasis?: boolean;
}) {
  const display = value === undefined ? '—' : value.toFixed(2);
  return (
    <Column
      gap="xs"
      style={{
        flex: '1 1 120px',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: emphasis
          ? 'var(--color-cybernetic-acquired, #a78bfa)'
          : 'var(--color-surface-2)',
      }}
    >
      <Text size="xs" variant="muted">
        {label}
      </Text>
      <Text size={emphasis ? 'xl' : 'lg'} weight="semibold">
        {display}
      </Text>
    </Column>
  );
}

// ---------------------------------------------------------------------------
// Recent results table
// ---------------------------------------------------------------------------

const RESULTS_PAGE_SIZE = 10;

function ResultsCard({ results }: { results: EvalResult[] }) {
  // Results arrive newest-first from the route; render a page at a time so a
  // long-running skill's history doesn't dump 20 rows (+ expanded failure
  // detail) into the tab at once.
  const [visibleCount, setVisibleCount] = useState(RESULTS_PAGE_SIZE);
  const visible = results.slice(0, visibleCount);
  const remaining = results.length - visible.length;

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Heading level={5}>Recent results</Heading>
            <Badge variant="neutral">{String(results.length)}</Badge>
          </Row>

          {results.length === 0 ? (
            <Text size="sm" variant="muted">
              No graded runs yet. Eval results land here as soon as the suite fires (after each
              completion by default).
            </Text>
          ) : (
            <>
              <div
                style={{
                  overflowX: 'auto',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-subtle)',
                }}
              >
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        background: 'var(--color-surface-2)',
                        textAlign: 'left',
                      }}
                    >
                      <Th>When</Th>
                      <Th>Verdict</Th>
                      <Th align="right">Overall</Th>
                      <Th align="right">Goal</Th>
                      <Th align="right">Task</Th>
                      <Th align="right">Traj</Th>
                      <Th>Confidence</Th>
                      <Th>Fault</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <ResultRow key={r.id} result={r} />
                    ))}
                  </tbody>
                </table>
              </div>
              {remaining > 0 && (
                <Row justify="center">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setVisibleCount((n) => n + RESULTS_PAGE_SIZE);
                    }}
                  >
                    Show {Math.min(remaining, RESULTS_PAGE_SIZE)} more
                  </Button>
                </Row>
              )}
            </>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function CoachFeedbackCard({
  observations,
  learnings,
}: {
  observations: CoachObservation[];
  learnings: CoachLearning[];
}) {
  const total = observations.length + learnings.length;
  if (total === 0) {
    return (
      <Card>
        <CardBody>
          <Column gap="sm">
            <Heading level={5}>Coach feedback</Heading>
            <Text size="sm" variant="muted">
              Coach has not recorded any observations or learnings for this skill in the recent
              window. Coach fires after runs; if you expect feedback and don&apos;t see it, check
              that the skill is past its bootstrap window and that the eval signal triggered.
            </Text>
          </Column>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Heading level={5}>Coach feedback</Heading>
            <Badge variant="neutral">{String(total)}</Badge>
          </Row>
          {learnings.length > 0 && (
            <Column gap="sm">
              <Text size="xs" weight="semibold" variant="muted">
                Durable learnings ({String(learnings.length)})
              </Text>
              {learnings.map((l) => (
                <LearningRow key={l.learningId} learning={l} />
              ))}
            </Column>
          )}
          {observations.length > 0 && (
            <Column gap="sm">
              <Text size="xs" weight="semibold" variant="muted">
                Observations ({String(observations.length)})
              </Text>
              {observations.map((o) => (
                <ObservationRow key={o.observationId} obs={o} />
              ))}
            </Column>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

function LearningRow({ learning }: { learning: CoachLearning }) {
  return (
    <Column
      gap="xs"
      style={{
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-2)',
      }}
    >
      <Row gap="sm" align="center" wrap>
        <Badge variant="info">{learning.kind}</Badge>
        <Badge variant="neutral">{learning.status}</Badge>
        <Text size="xs" variant="muted">
          {formatDateTime(learning.createdAt)}
        </Text>
      </Row>
      <Text size="sm">{learning.statement}</Text>
    </Column>
  );
}

function ObservationRow({ obs }: { obs: CoachObservation }) {
  return (
    <Column
      gap="xs"
      style={{
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-2)',
      }}
    >
      <Row gap="sm" align="center" wrap>
        <Badge variant="info">{obs.reason}</Badge>
        <Text size="xs" variant="muted">
          {formatDateTime(obs.createdAt)}
        </Text>
      </Row>
      <Text size="sm" weight="semibold">
        {obs.summary}
      </Text>
      {obs.detail && (
        <Text size="xs" variant="muted">
          {obs.detail}
        </Text>
      )}
      <Row gap="xs" wrap>
        <Text size="xs" variant="muted">
          run {obs.runId.slice(0, 8)}
        </Text>
      </Row>
    </Column>
  );
}

function VerdictBadge({ verdict }: { verdict: EvalResult['verdict'] }) {
  const v = verdict;
  const variant: 'success' | 'warning' | 'danger' | 'neutral' =
    v === 'pass' ? 'success' : v === 'fail' ? 'danger' : v === 'partial' ? 'warning' : 'neutral';
  return <Badge variant={variant}>{v}</Badge>;
}

function ResultRow({ result }: { result: EvalResult }) {
  const r = result;
  const isFailure = r.verdict === 'fail' || r.verdict === 'partial';
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
        <Td>
          <Text size="xs" variant="muted">
            {formatDateTime(r.evaluatedAt)}
          </Text>
        </Td>
        <Td>
          <VerdictBadge verdict={r.verdict} />
        </Td>
        <Td align="right">{r.scores.overall.toFixed(2)}</Td>
        <Td align="right">{r.scores.goalScore?.toFixed(2) ?? '—'}</Td>
        <Td align="right">{r.scores.taskScore?.toFixed(2) ?? '—'}</Td>
        <Td align="right">{r.scores.trajectoryScore?.toFixed(2) ?? '—'}</Td>
        <Td>
          <Badge variant="neutral">{r.confidence}</Badge>
        </Td>
        <Td>
          {r.faultLayer ? (
            <Badge variant="warning">{r.faultLayer}</Badge>
          ) : (
            <Text size="xs" variant="muted">
              —
            </Text>
          )}
        </Td>
      </tr>
      {isFailure && <FailureDetailRow result={r} />}
    </>
  );
}

function FailureDetailRow({ result }: { result: EvalResult }) {
  interface Entry {
    tier: string;
    criterion: EvalResult['goalResults'][number];
  }
  const failures: Entry[] = [
    ...result.goalResults.filter((c) => !c.passed).map((c) => ({ tier: 'Goal', criterion: c })),
    ...Object.entries(result.taskResults).flatMap(([taskId, arr]) =>
      arr.filter((c) => !c.passed).map((c) => ({ tier: `Task: ${taskId}`, criterion: c })),
    ),
    ...result.trajectoryResults
      .filter((c) => !c.passed)
      .map((c) => ({ tier: 'Trajectory', criterion: c })),
  ];
  if (failures.length === 0) return null;
  return (
    <tr>
      <td colSpan={8} style={{ padding: 0 }}>
        <Column
          gap="xs"
          style={{
            padding: 'var(--space-3) var(--space-4)',
            background: 'var(--color-surface-0)',
            borderTop: '1px dashed var(--color-border-subtle)',
          }}
        >
          {failures.map((f, i) => (
            <Row
              key={`${f.tier}-${String(i)}-${f.criterion.criterionName}`}
              gap="sm"
              align="start"
              wrap
            >
              <Badge variant="neutral">{f.tier}</Badge>
              <Text size="xs" weight="semibold">
                {f.criterion.criterionName}
              </Text>
              <Badge variant="neutral">{f.criterion.criterionType}</Badge>
              <Badge variant="danger">
                {f.criterion.score !== undefined ? f.criterion.score.toFixed(2) : 'fail'}
              </Badge>
              {f.criterion.evidence && (
                <Text size="xs" variant="muted" style={{ flex: '1 1 240px' }}>
                  {f.criterion.evidence}
                </Text>
              )}
              {f.criterion.judgeRationale && (
                <Text size="xs" variant="muted" style={{ flex: '1 1 240px' }}>
                  Judge: {f.criterion.judgeRationale}
                </Text>
              )}
            </Row>
          ))}
        </Column>
      </td>
    </tr>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <th
      style={{
        padding: 'var(--space-2) var(--space-3)',
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--color-text-muted)',
        textAlign: align,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <td
      style={{
        padding: 'var(--space-2) var(--space-3)',
        textAlign: align,
        verticalAlign: 'middle',
      }}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the oldest → newest series of overall scores used by the trend
 * sparkline. Filters out `error` verdicts (matches the baseline computation
 * in `baselineManager.ts`) so the line tracks substantive grades only.
 *
 * Accepts `null` so callers can invoke this unconditionally (stable hook
 * order) before they know whether the bundle has loaded.
 */
function useTrendSeries(results: EvalResult[] | null): number[] {
  return useMemo(() => {
    if (!results) return [];
    const filtered = results.filter((r) => r.verdict !== 'error');
    // Route returns newest first; sparkline wants oldest → newest.
    const reversed = [...filtered].reverse();
    return reversed.slice(-12).map((r) => r.scores.overall);
  }, [results]);
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
