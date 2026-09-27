'use client';

/**
 * The four evidence leaves of the attribution panel. Three registers carry
 * absence unambiguously: full strength means the fact is here, muted means
 * there is nothing and that is normal, warning means it is not known. A judge
 * verdict decides the result exactly as a deterministic check does, so it
 * carries the same colour and glyphs.
 */
import { useState } from 'react';
import { Badge, Column, Icon, Pressable, Row, Table, Td, Text, Th, Tr } from '@aflow/design-system';
import type { EvalCaseRubricResult, EvalTrialDetailView } from '@aflow/schemas';

import {
  EXPECTATION_KIND_LABEL,
  JUDGE_ERROR_SENTENCE,
  type TrialCheckGroup,
  type TrialReplyState,
  type TrialRubricGroups,
  type TrialTrajectoryFacts,
} from './evalsDerive.js';
import { evidencePreStyle } from './evalsStyles.js';

const JUDGE_VERDICT_VARIANT = {
  pass: 'success',
  fail: 'danger',
  unclear: 'warning',
} as const;

const failingRowStyle = {
  borderLeft: '2px solid var(--color-danger-default)',
  paddingLeft: 'var(--space-2)',
  paddingBlock: 'var(--space-1)',
} as const;

const passingRowStyle = {
  borderLeft: '2px solid var(--color-border-subtle)',
  paddingLeft: 'var(--space-2)',
  paddingBlock: 'var(--space-1)',
} as const;

export function ExpectationList({
  group,
  emptyCopy,
}: {
  group: TrialCheckGroup;
  emptyCopy: string;
}) {
  const [showPassing, setShowPassing] = useState(false);

  if (group.total === 0) {
    return (
      <Text size="xs" color="muted">
        {emptyCopy}
      </Text>
    );
  }

  const passing = group.passing.length;

  return (
    <Column gap="xs">
      {group.failing.map((result) => (
        <Row
          key={`${String(result.expectationIndex)}-${result.kind}`}
          gap="sm"
          align="start"
          wrap
          style={failingRowStyle}
        >
          <Icon name="x" size="xs" color="var(--color-danger-fg)" />
          <Text size="xs" tone="danger" weight="semibold">
            failed
          </Text>
          <Text size="xs" color="muted" variant="mono">
            #{result.expectationIndex}
          </Text>
          <Badge variant="neutral">{EXPECTATION_KIND_LABEL[result.kind]}</Badge>
          {result.detail !== undefined ? (
            <Text size="sm">{result.detail}</Text>
          ) : (
            <Text size="xs" color="muted">
              No detail recorded.
            </Text>
          )}
        </Row>
      ))}

      {passing > 0 && (
        <Pressable
          onClick={() => {
            setShowPassing((open) => !open);
          }}
          aria-expanded={showPassing}
          style={{ gap: 'var(--space-1)' }}
        >
          <Icon name={showPassing ? 'caret-down' : 'caret-right'} size="xs" />
          <Icon name="check" size="xs" />
          <Text size="xs" color="muted">
            {passing} check{passing === 1 ? '' : 's'} passed
          </Text>
        </Pressable>
      )}

      {showPassing &&
        group.passing.map((result) => (
          <Row
            key={`${String(result.expectationIndex)}-${result.kind}`}
            gap="sm"
            align="start"
            wrap
            style={passingRowStyle}
          >
            <Icon name="check" size="xs" />
            <Text size="xs" color="muted">
              passed
            </Text>
            <Text size="xs" color="muted" variant="mono">
              #{result.expectationIndex}
            </Text>
            <Badge variant="neutral">{EXPECTATION_KIND_LABEL[result.kind]}</Badge>
            {result.detail !== undefined && (
              <Text size="xs" color="muted">
                {result.detail}
              </Text>
            )}
          </Row>
        ))}
    </Column>
  );
}

export function TrajectoryTable({
  detail,
  facts,
}: {
  detail: EvalTrialDetailView;
  facts: TrialTrajectoryFacts;
}) {
  if (detail.runId === undefined) {
    return (
      <Text size="xs" color="muted">
        No run — nothing was dispatched, so there is no trajectory.
      </Text>
    );
  }

  if (facts.calls === 0) {
    return (
      <Column gap="xs">
        <Row gap="xs" align="center">
          <Icon name="warning-circle" size="xs" color="var(--color-warning-fg)" />
          <Text size="sm">The run reached no endpoint.</Text>
        </Row>
        <Text size="xs" color="muted">
          The evidence does not say whether the world was not consulted or could not be reached.
        </Text>
      </Column>
    );
  }

  const refused = facts.firstRefused;

  return (
    <Column gap="xs">
      {facts.soleSimulationId !== null && (
        <Text size="xs" color="muted">
          simulation: {facts.soleSimulationId}
        </Text>
      )}
      {refused !== null && (
        <Text size="sm">
          First refused call: #{refused.sequence} {refused.endpointId} → {refused.responseStatus}.
        </Text>
      )}
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Endpoint</Th>
              {facts.multiSimulation && <Th>Simulation</Th>}
              <Th>Status</Th>
              <Th>Write</Th>
            </tr>
          </thead>
          <tbody>
            {/* `sequence` is not the journal's `ordinal`, which restarts per endpoint —
                sorting by it reports an order the run never took. Render as given. */}
            {detail.trajectory.map((call) => (
              <Tr key={String(call.sequence)} muted={!call.mutated}>
                <Td>
                  <Text size="xs" color="muted" variant="mono">
                    {call.sequence}
                  </Text>
                </Td>
                <Td>
                  <Text size="xs" variant="mono">
                    {call.endpointId}
                  </Text>
                </Td>
                {facts.multiSimulation && (
                  <Td>
                    <Text size="xs" color="muted" variant="mono">
                      {call.simulationId}
                    </Text>
                  </Td>
                )}
                <Td>
                  <Text
                    size="xs"
                    variant="mono"
                    {...(call.responseStatus >= 400
                      ? { tone: 'danger' as const }
                      : call.responseStatus >= 300
                        ? { tone: 'warning' as const }
                        : {})}
                  >
                    {call.responseStatus}
                  </Text>
                </Td>
                <Td>{call.mutated && <Icon name="pencil" size="xs" />}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Column>
  );
}

export function ReplyBlock({ state }: { state: TrialReplyState }) {
  return (
    <Column gap="xs">
      <Text variant="label" size="xs" color="muted">
        Subject reply
      </Text>
      {state.state === 'text' && <pre style={evidencePreStyle}>{state.text}</pre>}
      {state.state === 'unresolved' && (
        <Column
          gap="xs"
          style={{
            padding: 'var(--space-2)',
            border: '1px solid var(--color-warning-default)',
            borderRadius: 'var(--radius-sm)',
            minHeight: 64,
          }}
        >
          <Row gap="xs" align="center">
            <Icon name="warning-circle" size="xs" color="var(--color-warning-fg)" />
            <Text size="sm" tone="warning">
              Reply unresolved.
            </Text>
          </Row>
          <Text size="xs" color="muted">
            A reply artifact exists but this read could not resolve it. The subject may have
            answered; an empty answer resolves the same way, so silence cannot be read from this.
          </Text>
          <Text size="xs" color="muted" variant="mono" title={state.ref}>
            ref {state.ref.slice(0, 24)}…
          </Text>
        </Column>
      )}
      {state.state === 'none' && (
        <Text size="xs" color="muted">
          No reply artifact — the run stopped without a pause contract.
        </Text>
      )}
      {state.state === 'no_run' && (
        <Text size="xs" color="muted">
          No run — no answer was produced.
        </Text>
      )}
    </Column>
  );
}

function slotLabel(criterionId: string, scopeKey: string): string {
  return `${criterionId} · ${scopeKey}`;
}

export function JudgeBlock({
  groups,
  verdict,
  hasRubrics,
  onFlagJudge,
}: {
  groups: TrialRubricGroups;
  verdict: EvalTrialDetailView['verdict'];
  hasRubrics: boolean;
  /** Absent when the trial has no run to attach a human verdict to. */
  onFlagJudge?: (row: Extract<EvalCaseRubricResult, { status: 'judged' }>) => void;
}) {
  const [showSampledOut, setShowSampledOut] = useState(false);

  const judgedPasses = groups.judged.filter((row) => row.verdict === 'pass').length;
  const showDisagreement = verdict === 'fail' && groups.judged.length > 0 && judgedPasses > 0;
  const otherOutcomes = groups.errors.length + groups.skipped.length + groups.notSelected.length;

  return (
    <Column
      gap="xs"
      style={{
        padding: 'var(--space-2) var(--space-3)',
        border: '1px dashed var(--color-border-subtle)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <Text size="xs" weight="semibold" color="muted">
        Judges. A failing judge fails the trial.
      </Text>

      {!hasRubrics && (
        <Text size="xs" color="muted">
          No rubrics on this suite.
        </Text>
      )}

      {hasRubrics && (
        <Text size="xs" color="muted">
          {groups.judged.length} judged · {groups.pending.length} never resolved
        </Text>
      )}

      {hasRubrics && groups.judged.length === 0 && groups.pending.length > 0 && (
        <Text size="xs" tone="warning">
          The judges did not run, so the rubric side of this case went unmeasured.
        </Text>
      )}

      {hasRubrics &&
        groups.judged.length === 0 &&
        groups.pending.length === 0 &&
        otherOutcomes > 0 && (
          <Text size="xs" color="muted">
            No judge returned a verdict.
          </Text>
        )}

      {showDisagreement && (
        <Text size="xs" color="muted">
          {judgedPasses === groups.judged.length
            ? 'Every judge that ran read this answer as a pass, so the failure comes from the checks alone.'
            : `${String(judgedPasses)} of ${String(groups.judged.length)} judges read this answer as a pass; the failure comes from the checks and the remaining judges.`}
        </Text>
      )}

      {groups.pending.length > 0 && (
        <Column gap="xs">
          <Text size="xs" tone="warning">
            The judge stage never resolved these slots, so they went unmeasured.
          </Text>
          {groups.pending.map((slot) => (
            <Text key={slot} size="xs" color="muted" variant="mono">
              {slot}
            </Text>
          ))}
        </Column>
      )}

      {groups.errors.map((row) => (
        <Column key={`${row.criterionId}|${row.scopeKey}`} gap="xs">
          <Row gap="xs" align="center" wrap>
            <Icon name="warning-circle" size="xs" color="var(--color-warning-fg)" />
            <Text size="xs" tone="warning" weight="semibold">
              judge failed
            </Text>
            <Text size="xs" color="muted" variant="mono">
              {slotLabel(row.criterionId, row.scopeKey)}
            </Text>
            <Badge variant="neutral">{row.errorCode}</Badge>
          </Row>
          <Text size="xs">{JUDGE_ERROR_SENTENCE[row.errorCode]}</Text>
          <Text size="xs" color="muted">
            {row.errorMessage}
          </Text>
          {row.judgeVersion !== undefined && (
            <Text size="xs" color="muted" variant="mono" title={row.judgeVersion}>
              v {row.judgeVersion.slice(0, 12)}…
            </Text>
          )}
        </Column>
      ))}

      {groups.judged.map((row) => (
        <Column key={`${row.criterionId}|${row.scopeKey}`} gap="xs">
          <Row gap="xs" align="center" wrap>
            {row.verdict === 'unclear' ? (
              <Icon name="warning-circle" size="xs" color="var(--color-warning-fg)" />
            ) : (
              <Icon
                name={row.verdict === 'pass' ? 'check' : 'x'}
                size="xs"
                {...(row.verdict === 'fail' ? { color: 'var(--color-danger-fg)' } : {})}
              />
            )}
            <Text size="xs" color="muted" variant="mono">
              {slotLabel(row.criterionId, row.scopeKey)}
            </Text>
            <Badge variant={JUDGE_VERDICT_VARIANT[row.verdict]}>
              judged {row.verdict} · {row.score.toFixed(2)}
            </Badge>
            {onFlagJudge !== undefined && (
              <Pressable
                onClick={() => {
                  onFlagJudge(row);
                }}
              >
                <Text size="xs" color="muted">
                  Wrong?
                </Text>
              </Pressable>
            )}
          </Row>
          {row.rationale === '' ? (
            <Text size="xs" color="muted">
              No rationale recorded.
            </Text>
          ) : (
            <pre style={evidencePreStyle}>{row.rationale}</pre>
          )}
          <Text size="xs" color="muted" variant="mono" title={row.judgeVersion}>
            v {row.judgeVersion.slice(0, 12)}…
          </Text>
        </Column>
      ))}

      {groups.skipped.length > 0 && (
        <Column gap="xs">
          {groups.skipped.map((row) => (
            <Row key={`${row.criterionId}|${row.scopeKey}`} gap="xs" align="center" wrap>
              <Icon name="info" size="xs" />
              <Text size="xs" color="muted">
                {slotLabel(row.criterionId, row.scopeKey)} — not judged: the trial produced no
                usable answer to judge.
              </Text>
            </Row>
          ))}
          <Text size="xs" color="muted">
            A failing check is judged like any other trial.
          </Text>
        </Column>
      )}

      {groups.notSelected.length > 0 && (
        <Column gap="xs">
          <Pressable
            onClick={() => {
              setShowSampledOut((open) => !open);
            }}
            aria-expanded={showSampledOut}
            style={{ gap: 'var(--space-1)' }}
          >
            <Icon name={showSampledOut ? 'caret-down' : 'caret-right'} size="xs" />
            <Text size="xs" color="muted">
              {groups.notSelected.length} sampled out by the suite&rsquo;s judge sampling rate.
            </Text>
          </Pressable>
          {showSampledOut &&
            groups.notSelected.map((row) => (
              <Text
                key={`${row.criterionId}|${row.scopeKey}`}
                size="xs"
                color="muted"
                variant="mono"
              >
                {slotLabel(row.criterionId, row.scopeKey)}
              </Text>
            ))}
        </Column>
      )}
    </Column>
  );
}
