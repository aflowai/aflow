'use client';

/**
 * Campaigns card — the skill's campaign instances (a series of runs toward a
 * numeric goal) with a per-campaign trajectory chart, direction-aware progress,
 * and the operator lifecycle (start / update mutable fields / end).
 *
 * Each campaign is its own optimization series (its own config), so its runs
 * plot on their own chart against the goal's target — never mixed with another
 * campaign's runs. Hidden entirely for skills that neither have a campaign
 * contract nor any campaigns, so non-campaign skills don't see an empty section.
 */
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Dialog,
  Heading,
  Icon,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';
import type {
  CampaignConfigChange,
  CyberneticEvalSuite,
  SkillCampaignContract,
  Workflow,
  WorkflowCampaignView,
} from '@aflow/schemas';
import { isCampaignFieldMutable } from '@aflow/schemas';

import { useApiQuery, useApiMutation } from '../../hooks/useApiQuery.js';
import { MetricChart, type MetricChartPoint } from '../graph/MetricChart.js';
import { fmtMetric } from '../graph/metricFormat.js';
import { findThresholdForMetric, meetsThreshold, operatorSymbol } from './goalThresholds.js';
import { CampaignFormDialog } from './CampaignFormDialog.js';

interface CampaignsResponse {
  campaigns: WorkflowCampaignView[];
}

export function CampaignsCard({
  spaceId,
  workflowSlug,
  workflow,
  suite,
  campaignContract,
}: {
  spaceId: string;
  workflowSlug: string;
  /** Parsed workflow doc — supplies the goal text shown once at the card head. */
  workflow: Workflow;
  /** Eval suite — supplies the target/operator for each campaign's chart. */
  suite?: CyberneticEvalSuite | null;
  /** When present, the skill can run campaigns — enables the start/update form. */
  campaignContract?: SkillCampaignContract | undefined;
}) {
  const query = useApiQuery<CampaignsResponse>({
    key: ['space', spaceId, 'workflow', workflowSlug, 'campaigns'],
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/campaigns?status=all`,
    spaceId,
    staleTime: 30_000,
  });
  const [startOpen, setStartOpen] = useState(false);

  const campaigns = query.data?.campaigns ?? [];
  // Render only when the skill can campaign (has a contract) or already has
  // campaigns — otherwise the section earns no space.
  if (query.isLoading && !query.data) return null;
  if (campaigns.length === 0 && !campaignContract) return null;

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Heading level={5}>Campaigns</Heading>
            {campaigns.length > 0 && <Badge variant="neutral">{campaigns.length}</Badge>}
            {query.isFetching && <Spinner size="sm" />}
            {campaignContract && (
              <Button
                variant="secondary"
                size="sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  setStartOpen(true);
                }}
              >
                <Icon name="plus" size="xs" /> Start campaign
              </Button>
            )}
          </Row>
          {workflow.goal && (
            <Text size="sm" variant="muted">
              {workflow.goal}
            </Text>
          )}
          {campaigns.length === 0 ? (
            <Text size="sm" variant="muted">
              No campaigns yet. Start one to run this skill as a series toward its goal.
            </Text>
          ) : (
            <Column gap="md">
              {campaigns.map((view) => (
                <CampaignRow
                  key={view.campaign.campaignId}
                  view={view}
                  spaceId={spaceId}
                  workflowSlug={workflowSlug}
                  suite={suite ?? null}
                  contract={campaignContract}
                />
              ))}
            </Column>
          )}
        </Column>
      </CardBody>
      {campaignContract && (
        <CampaignFormDialog
          open={startOpen}
          onClose={() => {
            setStartOpen(false);
          }}
          spaceId={spaceId}
          workflowSlug={workflowSlug}
          contract={campaignContract}
          mode="start"
        />
      )}
    </Card>
  );
}

function CampaignRow({
  view,
  spaceId,
  workflowSlug,
  suite,
  contract,
}: {
  view: WorkflowCampaignView;
  spaceId: string;
  workflowSlug: string;
  suite: CyberneticEvalSuite | null;
  contract?: SkillCampaignContract | undefined;
}) {
  const { campaign, scoreSummary, recentSeries } = view;
  const active = campaign.status === 'active';
  const configEntries = Object.entries(campaign.config ?? {});
  const [updateOpen, setUpdateOpen] = useState(false);
  // Update is offered only when there is at least one mutable field to change —
  // a contract of identity-only fields has nothing to update mid-campaign.
  const hasMutableField = contract
    ? Object.values(contract.fields).some(isCampaignFieldMutable)
    : false;

  const threshold = findThresholdForMetric(suite, campaign.scoreMetricKey);
  const target = threshold?.target ?? null;
  const changes = campaign.configHistory ?? [];
  const points: MetricChartPoint[] = recentSeries.map((pt, i) => {
    const marker = configMarkerBetween(recentSeries[i - 1]?.startedAt, pt.startedAt, changes);
    return {
      value: pt.score,
      ...(threshold ? { met: meetsThreshold(threshold, pt.score) } : {}),
      label: `Run #${String(i + 1)} · ${pt.runId.slice(0, 8)}`,
      sublabel: fmtWhen(pt.completedAt ?? pt.startedAt),
      ...(marker ? { marker } : {}),
    };
  });
  // Gap to target, oriented so a positive number always means "still to go".
  const gapToTarget =
    target !== null && scoreSummary.latestScore !== undefined
      ? campaign.direction === 'minimize'
        ? scoreSummary.latestScore - target
        : target - scoreSummary.latestScore
      : null;
  const reached =
    target !== null && scoreSummary.bestScore !== undefined && threshold
      ? meetsThreshold(threshold, scoreSummary.bestScore)
      : false;

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
        {active ? (
          <Badge variant="running">active</Badge>
        ) : (
          <Badge variant="neutral">
            ended{campaign.endedReason ? ` · ${campaign.endedReason}` : ''}
          </Badge>
        )}
        <Badge variant="info">
          {campaign.scoreMetricKey}{' '}
          {threshold ? `${operatorSymbol(threshold.operator)} ${fmtMetric(threshold.target)}` : ''}{' '}
          · {campaign.direction}
        </Badge>
        {reached && <Badge variant="success">target reached</Badge>}
        <Text size="xs" variant="muted">
          {scoreSummary.scoredRunCount} scored run{scoreSummary.scoredRunCount === 1 ? '' : 's'}
        </Text>
        {active && (
          <Row gap="xs" style={{ marginLeft: 'auto' }}>
            {contract && hasMutableField && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setUpdateOpen(true);
                }}
              >
                Update
              </Button>
            )}
            <EndCampaignButton
              spaceId={spaceId}
              workflowSlug={workflowSlug}
              campaignId={campaign.campaignId}
            />
          </Row>
        )}
      </Row>

      {configEntries.length > 0 && (
        <Row gap="xs" wrap>
          {configEntries.map(([k, v]) => (
            <Badge key={k} variant="neutral">
              {k}: {fmtConfigValue(v)}
            </Badge>
          ))}
        </Row>
      )}

      {points.length > 0 ? (
        <MetricChart
          points={points}
          target={target}
          {...(threshold?.targetHigh !== undefined ? { targetHigh: threshold.targetHigh } : {})}
          direction={campaign.direction}
          {...(threshold ? { targetOperator: operatorSymbol(threshold.operator) } : {})}
          metricLabel={campaign.scoreMetricKey}
          height={200}
          formatValue={fmtMetric}
          ariaLabel={`${campaign.scoreMetricKey} over ${String(points.length)} campaign runs`}
        />
      ) : (
        <Text size="sm" variant="muted">
          No scored runs yet. Each completed run plots here against the goal.
        </Text>
      )}

      <Row gap="md" wrap>
        <CampaignStat label="Best" value={scoreSummary.bestScore} highlight={reached} />
        <CampaignStat label="Latest" value={scoreSummary.latestScore} />
        {target !== null && <CampaignStat label="Target" value={target} />}
        {gapToTarget !== null && (
          <CampaignStat
            label={gapToTarget <= 0 ? 'Margin' : 'To go'}
            value={Math.abs(gapToTarget)}
            tone={gapToTarget <= 0 ? 'good' : undefined}
          />
        )}
      </Row>

      {contract && (
        <CampaignFormDialog
          open={updateOpen}
          onClose={() => {
            setUpdateOpen(false);
          }}
          spaceId={spaceId}
          workflowSlug={workflowSlug}
          contract={contract}
          mode="update"
          campaignId={campaign.campaignId}
          initialConfig={campaign.config ?? {}}
        />
      )}
    </Column>
  );
}

function EndCampaignButton({
  spaceId,
  workflowSlug,
  campaignId,
}: {
  spaceId: string;
  workflowSlug: string;
  campaignId: string;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useApiMutation<{ reason: string }>({
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/campaigns/${campaignId}/end`,
    method: 'POST',
    spaceId,
    invalidate: [['space', spaceId, 'workflow', workflowSlug, 'campaigns']],
    onSuccess: () => {
      setOpen(false);
    },
  });

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        End
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="End campaign"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                mutation.mutate({ reason: 'explicit' });
              }}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? 'Ending…' : 'End campaign'}
            </Button>
          </>
        }
      >
        <Column gap="sm">
          <Text size="sm">
            Ending freezes the campaign — its config and score series become immutable history. Runs
            already in flight finish; no new runs join it.
          </Text>
          {mutation.error && (
            <Text size="sm" tone="danger">
              {mutation.error.message}
            </Text>
          )}
        </Column>
      </Dialog>
    </>
  );
}

function CampaignStat({
  label,
  value,
  highlight,
  tone,
}: {
  label: string;
  value: number | undefined;
  highlight?: boolean;
  tone?: 'good' | undefined;
}) {
  return (
    <Column
      gap="xs"
      style={{
        flex: '0 1 110px',
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        background:
          highlight && value !== undefined
            ? 'var(--color-success-bg, var(--color-surface-0))'
            : 'transparent',
      }}
    >
      <Text size="xs" variant="muted">
        {label}
      </Text>
      <Text
        size="lg"
        weight="semibold"
        style={tone === 'good' ? { color: 'var(--color-success-text)' } : undefined}
      >
        {value === undefined ? '—' : fmtMetric(value)}
      </Text>
    </Column>
  );
}

function fmtConfigValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return Array.isArray(v) ? `[${String(v.length)}]` : 'object';
}

/**
 * A config-change marker for the run whose start falls just after the change —
 * i.e. the first run under the new config. Returns null when no change lands in
 * `(prevStartedAt, startedAt]`, so only real in-window transitions annotate the
 * line (a change predating the visible window doesn't).
 */
function configMarkerBetween(
  prevStartedAt: string | undefined,
  startedAt: string,
  changes: CampaignConfigChange[],
): { label: string; detail: string } | null {
  if (prevStartedAt === undefined || changes.length === 0) return null;
  const lo = Date.parse(prevStartedAt);
  const hi = Date.parse(startedAt);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const hits = changes.filter((ch) => {
    const t = Date.parse(ch.changedAt);
    return Number.isFinite(t) && t > lo && t <= hi;
  });
  if (hits.length === 0) return null;
  const keys = [...new Set(hits.flatMap((h) => h.changedKeys))];
  const shown = keys.slice(0, 2).join(', ');
  const label = `⚙ ${keys.length > 2 ? `${shown} +${String(keys.length - 2)}` : shown}`;
  const detail = hits
    .flatMap((h) =>
      h.changedKeys.map(
        (k) => `${k}: ${fmtConfigValue(h.previous[k])} → ${fmtConfigValue(h.next[k])}`,
      ),
    )
    .join(' · ');
  return { label, detail };
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
