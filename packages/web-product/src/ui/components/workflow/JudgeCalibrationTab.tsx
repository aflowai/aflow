'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardHeader, CardBody, Badge, Text, Stack, Inline, Icon } from '@aflow/design-system';
import { useApi, useSpaceFromRoute } from '../providers.js';
import { useRouter } from 'next/navigation';
import { JudgeLabelDrawer } from './JudgeLabelDrawer.js';
import { buildJudgeRepairDraft } from './judgeRepairDraft.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CalibrationSample {
  runId: string;
  verdict: string;
  judgeLabel: string | null;
  judgeScore: string | null;
  critique: string;
  labeledAt: string;
  agreed: boolean;
}

interface CalibrationStats {
  criterionId: string;
  agreementRate: number | null;
  /** This page of samples — capped by the endpoint, never the full set. */
  sampleCount: number;
  /** Every label recorded for the criterion, which is what the badge counts. */
  totalCount: number;
  samples: CalibrationSample[];
}

/** Scope disambiguates same-named criteria across goal/task/trajectory. */
type CriterionScope = 'goal' | 'trajectory' | { task: string };

interface JudgeCalibrationTabProps {
  spaceId: string;
  criterionId: string;
  criterionName: string;
  /** Eval suite path (e.g. /evals/daily-metrics/suite.json) for scoped queries. */
  evalSuitePath: string;
  /** Which scope the criterion belongs to. */
  scope: CriterionScope;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function JudgeCalibrationTab({
  spaceId,
  criterionId,
  criterionName,
  evalSuitePath,
  scope,
}: JudgeCalibrationTabProps) {
  const { apiUrl, headers } = useApi();
  const router = useRouter();
  const spaceSlug = useSpaceFromRoute()?.slug ?? '';
  const [stats, setStats] = useState<CalibrationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const cancelRef = useRef<AbortController | null>(null);

  const loadStats = useCallback(async () => {
    cancelRef.current?.abort();
    const ctrl = new AbortController();
    cancelRef.current = ctrl;

    setLoading(true);
    setError(null);

    try {
      const url = new URL(
        `${apiUrl}/spaces/${spaceId}/judge-calibration/${encodeURIComponent(criterionId)}`,
        window.location.origin,
      );
      url.searchParams.set('evalSuitePath', evalSuitePath);
      const scopeKey = typeof scope === 'string' ? scope : `task:${scope.task}`;
      url.searchParams.set('scopeKey', scopeKey);
      const res = await fetch(url.toString(), { headers: headers(), signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const data = (await res.json()) as CalibrationStats;
      setStats(data);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiUrl, headers, spaceId, criterionId, evalSuitePath]);

  useEffect(() => {
    void loadStats();
    return () => cancelRef.current?.abort();
  }, [loadStats]);

  if (loading) {
    return (
      <Card>
        <CardBody>
          <Text size="sm" variant="muted">
            Loading calibration data...
          </Text>
        </CardBody>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardBody>
          <Text size="sm" style={{ color: 'var(--color-danger-default)' }}>
            Failed to load calibration: {error}
          </Text>
        </CardBody>
      </Card>
    );
  }

  // `agreed` is false for an unpaired label too — one where no judge verdict
  // was recorded at all. That is an absent comparison, not a disagreement, and
  // offering a rubric repair over it argues from nothing.
  const disagreements = (stats?.samples ?? []).filter(
    (sample) => sample.judgeLabel !== null && !sample.agreed,
  );

  const agreementPct =
    stats?.agreementRate != null ? `${String(Math.round(stats.agreementRate * 100))}%` : 'N/A';

  return (
    <>
      <Card>
        <CardHeader>
          <Inline gap="2" align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
            <Inline gap="2" align="center">
              <Icon name="sliders" size="sm" />
              <Text size="sm" style={{ fontWeight: 'var(--font-weight-medium)' }}>
                {criterionName}
              </Text>
            </Inline>
            <Badge variant={(stats?.totalCount ?? 0) === 0 ? 'warning' : 'neutral'}>
              {(stats?.totalCount ?? 0) === 0
                ? 'Not yet checked against a human'
                : `Checked against ${String(stats?.totalCount ?? 0)} human labels`}
            </Badge>
          </Inline>
        </CardHeader>
        <CardBody>
          <Stack gap="3">
            {/* Summary stats */}
            <Inline gap="4">
              <Stack gap="1">
                <Text size="sm" variant="muted">
                  Agreement Rate
                </Text>
                <Text
                  size="sm"
                  style={{
                    fontWeight: 'var(--font-weight-medium)',
                    color:
                      stats?.agreementRate != null && stats.agreementRate >= 0.8
                        ? 'var(--color-success-default)'
                        : 'var(--color-text-default)',
                  }}
                >
                  {agreementPct}
                </Text>
              </Stack>
              <Stack gap="1">
                <Text size="sm" variant="muted">
                  Samples
                </Text>
                <Text size="sm" style={{ fontWeight: 'var(--font-weight-medium)' }}>
                  {String(stats?.totalCount ?? 0)}
                </Text>
              </Stack>
            </Inline>

            {/* Recent samples */}
            {stats && stats.samples.length > 0 && (
              <Stack gap="1">
                <Text size="sm" variant="muted">
                  Recent verdicts
                </Text>
                {stats.samples.slice(0, 10).map((s) => (
                  <Inline
                    key={`${s.runId}-${s.labeledAt}`}
                    gap="2"
                    align="center"
                    style={{
                      padding: 'var(--space-1) var(--space-2)',
                      borderRadius: 'var(--radius-sm)',
                      background: s.agreed
                        ? 'var(--color-success-subtle)'
                        : 'var(--color-danger-subtle)',
                    }}
                  >
                    <Icon name={s.agreed ? 'check-circle' : 'warning-circle'} size="sm" />
                    <Text size="sm">
                      Judge: {s.judgeLabel ?? '—'}
                      {s.judgeScore != null ? ` (${s.judgeScore})` : ''}
                    </Text>
                    <Text size="sm" variant="muted">
                      Human: {s.verdict}
                    </Text>
                    <Text size="sm" variant="muted" style={{ marginLeft: 'auto' }}>
                      {new Date(s.labeledAt).toLocaleDateString()}
                    </Text>
                  </Inline>
                ))}
              </Stack>
            )}

            {disagreements.length > 0 && (
              <Stack gap="1">
                <Text size="sm" variant="muted">
                  {disagreements.length === 1
                    ? 'One recorded verdict disagrees with this judge.'
                    : `${String(disagreements.length)} recorded verdicts disagree with this judge.`}
                </Text>
                <button
                  type="button"
                  onClick={() => {
                    router.push(
                      `/s/${spaceSlug}/chat?draft=${encodeURIComponent(
                        buildJudgeRepairDraft({
                          criterionName,
                          criterionId,
                          evalSuitePath,
                          scopeKey: typeof scope === 'string' ? scope : `task:${scope.task}`,
                          disagreements,
                          sampledFrom: {
                            read: stats?.samples.length ?? 0,
                            total: stats?.totalCount ?? 0,
                          },
                        }),
                      )}`,
                    );
                  }}
                  disabled={spaceSlug === ''}
                  style={{
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border-default)',
                    background: 'var(--color-surface-0)',
                    cursor: spaceSlug === '' ? 'not-allowed' : 'pointer',
                    fontSize: 'var(--font-size-sm)',
                    textAlign: 'left',
                  }}
                >
                  Ask Helmsman to fix this criterion
                </button>
              </Stack>
            )}

            {/* Label button */}
            <button
              type="button"
              onClick={() => {
                setDrawerOpen(true);
              }}
              style={{
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-default)',
                background: 'var(--color-surface-0)',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              Label a run
            </button>
          </Stack>
        </CardBody>
      </Card>

      {drawerOpen && (
        <JudgeLabelDrawer
          spaceId={spaceId}
          criterionId={criterionId}
          criterionName={criterionName}
          evalSuitePath={evalSuitePath}
          scope={scope}
          onClose={() => {
            setDrawerOpen(false);
          }}
          onSaved={() => {
            setDrawerOpen(false);
            void loadStats();
          }}
        />
      )}
    </>
  );
}
