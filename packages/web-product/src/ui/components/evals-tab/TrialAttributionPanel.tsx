'use client';

/**
 * One trial, partitioned into the three exits a failure can belong to: the
 * contract the run reached, the instructions it answered under, or the case it
 * was measured against. The headline names an exit only when the evidence
 * separates them: a failing judge names the answer and the rubric together,
 * and unresolved artifacts may demote a call to contested.
 */
import { useState, type ReactNode } from 'react';
import {
  Accordion,
  Badge,
  Button,
  Column,
  Icon,
  Pressable,
  Row,
  Spinner,
  Text,
  type AccordionItemData,
  type BadgeVariant,
} from '@aflow/design-system';
import type { EvalBatchCaseResultView, EvalTrialDetailView } from '@aflow/schemas';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import type { EvalTrialDetailResponse } from './evalsApi.js';
import { evalsKeys } from './evalsApi.js';
import {
  deriveSiblingTrials,
  deriveTrialAttribution,
  deriveTrialChecks,
  deriveTrialReplyState,
  deriveTrialRubricGroups,
  deriveTrialTrajectoryFacts,
  formatJudgeSummary,
  formatPct,
  formatSiblingSummary,
  type SiblingTrial,
  type TrialChecks,
  type TrialExit,
  type TrialTrajectoryFacts,
} from './evalsDerive.js';
import { JudgeBlock, ExpectationList, ReplyBlock, TrajectoryTable } from './TrialEvidence.js';
import { JudgeFlagDialog, type JudgeFlagSubject } from './JudgeFlagDialog.js';

const RUN_STATUS_BADGE: Record<NonNullable<EvalTrialDetailView['runStatus']>, BadgeVariant> = {
  running: 'running',
  paused: 'paused',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

const VERDICT_BADGE: Record<'pass' | 'fail' | 'error', BadgeVariant> = {
  pass: 'success',
  fail: 'danger',
  error: 'warning',
};

const SIBLING_DOT_COLOR: Record<'pass' | 'fail' | 'error' | 'none', string> = {
  pass: 'var(--color-success-default)',
  fail: 'var(--color-danger-default)',
  error: 'var(--color-warning-default)',
  none: 'var(--color-border-default)',
};

const NON_TERMINAL_DISPOSITIONS: ReadonlySet<EvalTrialDetailView['disposition']> = new Set([
  'scheduled',
  'running',
  'infra_retry',
]);

function checkClause(total: number, failing: number, emptyCopy: string): string {
  if (total === 0) return emptyCopy;
  return `${String(total)} check${total === 1 ? '' : 's'}, ${String(failing)} failed`;
}

function contractSubtitle(
  detail: EvalTrialDetailView,
  checks: TrialChecks,
  facts: TrialTrajectoryFacts,
): string {
  if (detail.runId === undefined) return 'no run';
  const calls =
    facts.calls === 0
      ? 'no calls'
      : `${String(facts.calls)} call${facts.calls === 1 ? '' : 's'} · ${String(facts.refused)} refused`;
  return `${calls} · ${checkClause(checks.contract.total, checks.contract.failing.length, 'no contract checks')}`;
}

const REPLY_LABEL = {
  text: 'reply read',
  unresolved: 'reply unresolved',
  none: 'no reply artifact',
  no_run: 'no run',
} as const;

function SiblingTrialStrip({
  siblings,
  openTrial,
  onSelect,
}: {
  siblings: SiblingTrial[];
  openTrial: number;
  onSelect: (trial: number) => void;
}) {
  const summary = formatSiblingSummary(siblings);
  return (
    <Row gap="xs" align="center" wrap>
      {siblings.map((sibling) => (
        <Pressable
          key={sibling.trial}
          onClick={() => {
            onSelect(sibling.trial);
          }}
          aria-label={`Trial ${String(sibling.trial)} — ${sibling.verdict ?? 'not graded'}`}
          style={{
            width: 10,
            height: 10,
            flex: '0 0 auto',
            borderRadius: '50%',
            background: SIBLING_DOT_COLOR[sibling.verdict ?? 'none'],
            ...(sibling.trial === openTrial
              ? { outline: '2px solid var(--color-accent-default)', outlineOffset: 2 }
              : {}),
          }}
        />
      ))}
      {summary !== null && (
        <Text size="xs" color="muted">
          {summary}
        </Text>
      )}
    </Row>
  );
}

export function TrialAttributionPanel({
  spaceId,
  workflowSlug,
  batchId,
  caseRevisionId,
  trial,
  row,
  caseResults,
  onSelectTrial,
  onClose,
}: {
  spaceId: string;
  workflowSlug: string;
  batchId: string;
  caseRevisionId: string;
  trial: number;
  row: EvalBatchCaseResultView;
  caseResults: readonly EvalBatchCaseResultView[];
  onSelectTrial: (caseRevisionId: string, trial: number) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string[] | null>(null);
  const [flagging, setFlagging] = useState<JudgeFlagSubject | null>(null);

  const trialQuery = useApiQuery<EvalTrialDetailResponse>({
    key: evalsKeys.trial(spaceId, batchId, caseRevisionId, trial),
    path: `/spaces/${spaceId}/eval-batches/${batchId}/cases/${caseRevisionId}/trials/${String(trial)}`,
    spaceId,
    staleTime: 30_000,
  });

  const panelId = `trial-attribution-${caseRevisionId}-${String(trial)}`;
  const detail = trialQuery.data;
  const siblings = deriveSiblingTrials(caseResults, caseRevisionId);

  return (
    <Column
      gap="md"
      id={panelId}
      style={{
        padding: 'var(--space-3)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <Row gap="sm" align="center" wrap>
        <Text size="sm" weight="semibold">
          {row.caseTitle ?? row.caseRevisionId.slice(0, 8)}
        </Text>
        <Text size="sm" color="muted">
          trial {row.trial}
        </Text>
        {row.verdict !== undefined ? (
          <Badge variant={VERDICT_BADGE[row.verdict]}>{row.verdict}</Badge>
        ) : (
          <Badge variant="neutral">not graded</Badge>
        )}
        <Badge variant="neutral">{row.disposition}</Badge>
        {detail?.runStatus !== undefined && (
          <Badge variant={RUN_STATUS_BADGE[detail.runStatus]}>{detail.runStatus}</Badge>
        )}
        {detail?.runId !== undefined && detail.runStatus === undefined && (
          <Text size="xs" tone="warning">
            Run record unreadable.
          </Text>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </Row>

      {siblings.length > 1 && (
        <SiblingTrialStrip
          siblings={siblings}
          openTrial={trial}
          onSelect={(next) => {
            onSelectTrial(caseRevisionId, next);
          }}
        />
      )}

      {detail === undefined && trialQuery.isLoading && <Spinner size="sm" label="Loading trial" />}

      {detail === undefined && trialQuery.error !== null && (
        <Row gap="sm" align="center" wrap>
          <Text size="sm" tone="danger">
            Could not load the trial. {trialQuery.error.message}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void trialQuery.refetch();
            }}
          >
            Retry
          </Button>
        </Row>
      )}

      {detail !== undefined && (
        <TrialAttributionBody
          detail={detail}
          expanded={expanded}
          onExpandedChange={setExpanded}
          onFlagJudge={setFlagging}
          staleError={trialQuery.error !== null ? trialQuery.error.message : null}
          onRefresh={() => {
            void trialQuery.refetch();
          }}
        />
      )}

      {flagging !== null && detail?.runId !== undefined && (
        <JudgeFlagDialog
          spaceId={spaceId}
          workflowSlug={workflowSlug}
          batchId={batchId}
          caseRevisionId={caseRevisionId}
          trial={trial}
          runId={detail.runId}
          subject={flagging}
          onClose={() => {
            setFlagging(null);
          }}
        />
      )}
    </Column>
  );
}

function TrialAttributionBody({
  detail,
  expanded,
  onExpandedChange,
  staleError,
  onRefresh,
  onFlagJudge,
}: {
  detail: EvalTrialDetailView;
  expanded: string[] | null;
  onExpandedChange: (ids: string[]) => void;
  staleError: string | null;
  onRefresh: () => void;
  onFlagJudge: (subject: JudgeFlagSubject) => void;
}) {
  const attribution = deriveTrialAttribution(detail);
  const checks = deriveTrialChecks(detail);
  const facts = deriveTrialTrajectoryFacts(detail);
  const replyState = deriveTrialReplyState(detail);
  const groups = deriveTrialRubricGroups(detail);
  const hasRubrics = detail.rubricResults.length > 0 || detail.pendingRubrics.length > 0;
  const judgeSummary = formatJudgeSummary(groups, hasRubrics);

  const numbers: string[] = [];
  numbers.push(
    checks.total === 0
      ? 'no checks recorded'
      : `${String(checks.passedCount)} of ${String(checks.total)} checks passed` +
          (detail.fractionPassed !== undefined ? ` (${formatPct(detail.fractionPassed)})` : ''),
  );
  if (facts.calls > 0) {
    numbers.push(
      `${String(facts.calls)} call${facts.calls === 1 ? '' : 's'}, ${String(facts.mutating)} mutating, ${String(facts.refused)} refused`,
    );
  }
  numbers.push(`judges: ${judgeSummary}`);

  function exitBadge(exit: TrialExit): ReactNode {
    if (!attribution.exits.includes(exit)) return undefined;
    return (
      <Badge variant="accent">{attribution.exits.length === 1 ? 'suspect' : 'candidate'}</Badge>
    );
  }

  const items: AccordionItemData[] = [
    {
      id: 'contract',
      title: 'Contract — the endpoints the run reached',
      subtitle: contractSubtitle(detail, checks, facts),
      badge: exitBadge('contract'),
      children: (
        <Column gap="sm">
          <ExpectationList
            group={checks.contract}
            emptyCopy="No contract check covers this case."
          />
          <TrajectoryTable detail={detail} facts={facts} />
        </Column>
      ),
    },
    {
      id: 'instruction',
      title: 'Instructions — the answer the run gave',
      subtitle: `${REPLY_LABEL[replyState.state]} · ${checkClause(checks.instruction.total, checks.instruction.failing.length, 'no checks on the answer')}`,
      badge: exitBadge('instruction'),
      children: (
        <Column gap="sm">
          <ReplyBlock state={replyState} />
          <ExpectationList
            group={checks.instruction}
            emptyCopy="No check covers the answer on this case."
          />
        </Column>
      ),
    },
    {
      id: 'expectation',
      title: 'The case — what the trial was measured against',
      subtitle: judgeSummary,
      badge: exitBadge('expectation'),
      children: (
        <JudgeBlock
          groups={groups}
          verdict={detail.verdict}
          hasRubrics={hasRubrics}
          {...(detail.runId !== undefined
            ? {
                onFlagJudge: (judged) => {
                  onFlagJudge({
                    criterionId: judged.criterionId,
                    scopeKey: judged.scopeKey,
                    verdict: judged.verdict,
                    judgeVersion: judged.judgeVersion,
                    rationale: judged.rationale,
                  });
                },
              }
            : {})}
        />
      ),
    },
  ];

  return (
    <>
      <Column
        gap="xs"
        style={{
          padding: 'var(--space-2) var(--space-3)',
          borderLeft: attribution.confident
            ? '3px solid var(--color-accent-default)'
            : '3px solid var(--color-border-subtle)',
          background: 'var(--color-surface-1)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <Text size={attribution.confident ? 'base' : 'sm'} weight="semibold">
          {attribution.headline}
        </Text>
        {attribution.basis.map((sentence) => (
          <Text key={sentence} size="sm">
            {sentence}
          </Text>
        ))}
        {(attribution.status === 'attributed' || attribution.status === 'contested') && (
          <Text size="xs" color="muted">
            Read from the evidence below.
          </Text>
        )}
      </Column>

      <Column gap="xs">
        <Text size="xs" color="muted">
          {numbers.join(' · ')}
        </Text>
        {checks.fractionMismatch !== null && (
          <Text size="xs" tone="warning">
            {checks.fractionMismatch}
          </Text>
        )}
      </Column>

      {attribution.suppressExitCards ? (
        <Column gap="sm">
          <Row gap="xs" align="center">
            <Icon name="warning-circle" size="xs" color="var(--color-warning-fg)" />
            <Text size="sm" tone="warning">
              Nothing was read from the grading record.
            </Text>
          </Row>
          <Text size="xs" color="muted">
            The run&rsquo;s own evidence is unaffected and is shown below.
          </Text>
          <Text variant="label" size="xs">
            Evidence
          </Text>
          <TrajectoryTable detail={detail} facts={facts} />
          <ReplyBlock state={replyState} />
        </Column>
      ) : (
        <Accordion
          multiple
          items={items}
          expanded={expanded ?? attribution.expandCards}
          onExpandedChange={onExpandedChange}
        />
      )}

      {staleError !== null && (
        <Text size="xs" tone="warning">
          The trial could not be refreshed. {staleError}
        </Text>
      )}

      <Row gap="sm" align="center" wrap>
        {detail.runId !== undefined && (
          <Text size="xs" color="muted" variant="mono" title={detail.runId}>
            run {detail.runId.slice(0, 12)}…
          </Text>
        )}
        <Text size="xs" color="muted" variant="mono" title={detail.caseRevisionId}>
          case {detail.caseRevisionId.slice(0, 8)}…
        </Text>
        <Text size="xs" color="muted" variant="mono" title={detail.batchId}>
          batch {detail.batchId.slice(0, 8)}…
        </Text>
        {NON_TERMINAL_DISPOSITIONS.has(detail.disposition) && (
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            Refresh
          </Button>
        )}
      </Row>
    </>
  );
}
