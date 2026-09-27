'use client';

import { useEffect, useRef, useState } from 'react';
import { Column, Icon, JsonViewer, Row, Spinner, Text } from '@aflow/design-system';
import type { WorkflowResumeContract, WorkflowRunPauseReason } from '@aflow/schemas';
import { useSpace } from '../providers.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { Pill } from './WorkflowRunSurfaceParts.js';
import type { PillTone } from './workflowRunSurfaceHelpers.js';

const PROMPT_CLAMP_LINES = 3;

function LinkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        marginTop: 2,
        padding: 0,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: 11,
        color: 'var(--color-accent-default)',
        alignSelf: 'flex-start',
      }}
    >
      {label}
    </button>
  );
}

/**
 * Multi-line prose clamped to `PROMPT_CLAMP_LINES` with a Show more/less
 * toggle. The toggle only appears when the text actually overflows the clamp
 * (measured post-layout — no char-count heuristic), so short prompts read as
 * a plain line.
 */
function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);
  return (
    <Column gap="0-5">
      <div
        ref={ref}
        style={{
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          lineHeight: 1.4,
          ...(expanded
            ? {}
            : {
                display: '-webkit-box',
                WebkitLineClamp: PROMPT_CLAMP_LINES,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }),
        }}
      >
        {text}
      </div>
      {(overflowing || expanded) && (
        <LinkButton
          label={expanded ? 'Show less' : 'Show more'}
          onClick={() => {
            setExpanded((v) => !v);
          }}
        />
      )}
    </Column>
  );
}

/** Structured value → collapsible JsonViewer; primitive → plain text. */
function JsonOrText({ value }: { value: unknown }) {
  if (value !== null && typeof value === 'object') {
    return <JsonViewer data={value} collapsed collapseDepth={2} maxHeight="240px" />;
  }
  return <DetailLine>{String(value)}</DetailLine>;
}

const CAUSE_META: Record<WorkflowRunPauseReason, { label: string; tone: PillTone }> = {
  task_contract_violation: { label: 'contract violation', tone: 'warning' },
  transient_error: { label: 'transient error', tone: 'warning' },
  needs_credentials: { label: 'needs credentials', tone: 'info' },
  needs_capability: { label: 'needs capability', tone: 'info' },
  needs_decision: { label: 'needs decision', tone: 'info' },
  needs_oauth_consent: { label: 'needs connection', tone: 'info' },
  retry_budget_exceeded: { label: 'retry budget exceeded', tone: 'destructive' },
  subagent_handoff: { label: 'sub-skill handoff', tone: 'info' },
  manual: { label: 'paused', tone: 'muted' },
};

const MAX_CONTRACT_ERRORS = 4;

function DetailLine({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: 'var(--color-text-secondary)',
        lineHeight: 1.35,
        overflowWrap: 'anywhere',
        maxWidth: '100%',
      }}
    >
      {children}
    </div>
  );
}

function ContractErrorsDetail({ contract }: { contract: WorkflowResumeContract }) {
  const errors = contract.contractErrors ?? [];
  if (errors.length === 0) return null;
  const shown = errors.slice(0, MAX_CONTRACT_ERRORS);
  const extra = errors.length - shown.length;
  return (
    <Column gap="0-5">
      {shown.map((e, i) => {
        const issue = e.zodIssues[0];
        const path = issue && issue.path.length > 0 ? issue.path.join('.') : null;
        const text = issue
          ? `${e.contractName}${path ? ` · ${path}` : ''} — ${issue.message}`
          : `${e.contractName} (${e.blame})`;
        return (
          <DetailLine key={`${e.contractName}-${String(i)}`}>
            <span title={text}>{text}</span>
          </DetailLine>
        );
      })}
      {extra > 0 && <DetailLine>+{extra} more</DetailLine>}
    </Column>
  );
}

function BlockedBindingsDetail({
  contract,
  spaceSlug,
}: {
  contract: WorkflowResumeContract;
  spaceSlug: string | undefined;
}) {
  const bindings = contract.blockedBindings ?? [];
  if (bindings.length === 0) return null;
  return (
    <Column gap="0-5">
      {bindings.map((b) => {
        const text = `${b.bindingName} — missing ${b.missingFields.join(', ')}`;
        return (
          <DetailLine key={b.bindingId}>
            <span title={text}>{text}</span>
          </DetailLine>
        );
      })}
      <a
        href={spaceRoute(spaceSlug, '/integrations')}
        style={{
          fontSize: 11,
          color: 'var(--color-accent-default)',
          textDecoration: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
        }}
      >
        <Icon name="arrow-square-out" size="xs" />
        Fix at integrations
      </a>
    </Column>
  );
}

function CauseSpecificDetail({
  contract,
  spaceSlug,
}: {
  contract: WorkflowResumeContract;
  spaceSlug: string | undefined;
}) {
  switch (contract.pauseCause) {
    case 'task_contract_violation': {
      const failed = contract.failedOutputPreview;
      return (
        <Column gap="1">
          <ContractErrorsDetail contract={contract} />
          {failed !== undefined && (
            <Column gap="0-5">
              <Text size="xs" variant="muted">
                Failed output
              </Text>
              <JsonOrText value={failed} />
            </Column>
          )}
        </Column>
      );
    }
    case 'transient_error': {
      const code = contract.errorCode;
      const message = contract.errorMessage;
      if (!code && !message) return null;
      return (
        <DetailLine>
          {code && <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{code}</span>}
          {code && message ? ' — ' : ''}
          {message && <span title={message}>{message}</span>}
        </DetailLine>
      );
    }
    case 'needs_credentials':
      return <BlockedBindingsDetail contract={contract} spaceSlug={spaceSlug} />;
    case 'needs_capability': {
      const caps = contract.disabledCapabilities ?? [];
      if (caps.length === 0) return null;
      return <DetailLine>disabled: {caps.join(', ')}</DetailLine>;
    }
    // These causes carry no extra structured detail beyond the prompt.
    // `needs_oauth_consent`: the actionable "Connect {provider}" affordance is
    // the Action Center card (Plan 185 §9.3 Plane B); this read-only surface
    // shows only the cause pill + prompt.
    case 'needs_decision':
    case 'needs_oauth_consent':
    case 'retry_budget_exceeded':
    case 'subagent_handoff':
    case 'manual':
      return null;
  }
}

interface PauseExplanationProps {
  /** Rich pause contract (BFF-surfaced). Absent until detail hydrates. */
  contract: WorkflowResumeContract | undefined;
  /** Coarse run-level pause reason from the live event — instant fallback. */
  pausedReason: string | undefined;
}

/**
 * Read-only explanation for a non-human paused task — the agent/operation
 * gap that `PausedHumanTaskRow` (approve/collect) doesn't cover. Shows the
 * cause + the always-present `resumePrompt` + a thin cause-specific layer.
 * Falls back to the coarse `pausedReason` (+ spinner) while the contract
 * hydrates from `workflow.run.detail`.
 */
export function PauseExplanation({ contract, pausedReason }: PauseExplanationProps) {
  const { activeSpace } = useSpace();
  const spaceSlug = activeSpace?.slug;

  if (!contract) {
    return (
      <Row gap="2" align="center" style={{ marginTop: 'var(--space-2)' }}>
        <Pill label={pausedReason ?? 'paused'} tone="muted" />
        <Spinner size="sm" />
        <Text size="xs" variant="muted">
          Loading pause details…
        </Text>
      </Row>
    );
  }

  const meta = CAUSE_META[contract.pauseCause];

  return (
    <Column gap="1-5" className="ds-enter-rise" style={{ marginTop: 'var(--space-2)' }}>
      <Row gap="1" align="center" style={{ flexWrap: 'wrap' }}>
        <Pill label={meta.label} tone={meta.tone} />
        {contract.attemptCount !== undefined && contract.attemptCount > 0 && (
          <Pill
            label={`attempt ${String(contract.attemptCount)}`}
            tone="muted"
            title="Resume attempts made on this pause already"
          />
        )}
      </Row>
      <ExpandableText text={contract.resumePrompt} />
      <CauseSpecificDetail contract={contract} spaceSlug={spaceSlug} />
    </Column>
  );
}
