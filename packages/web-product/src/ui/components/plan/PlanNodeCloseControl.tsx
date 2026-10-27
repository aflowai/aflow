'use client';

/**
 * The operator's own writes on an open plan node (Plan 322 P3.2), held in the
 * board's rail: mark it done with how its criteria were met — for a `decide`
 * node, the choice — or drop it, and the branch under it with it; and on a
 * `blocked` node, **Approve** it — **Resume** where a stop blocked it — which
 * moves it to `active` through the open write, never the close (Plan 331 D5,
 * Plan 332 D6). The form shows the node as the rail read it, on demand, and
 * writes against the revision that read showed; a node changed since is
 * refused rather than overwritten, and a refusal reads it again.
 */
import { useState } from 'react';
import { Button, Column, Row, Text, Textarea } from '@aflow/design-system';
import type { PlanNode, PlanNodeStatus, PlanTreeNode } from '@aflow/schemas';

/** What the operator asks of one node: close it, against the revision they read. */
export interface PlanNodeCloseRequest {
  nodeId: string;
  expectedRevision: number;
  status: 'done' | 'dropped';
  outcome?: string;
}

export type PlanNodeCloseAnswer = { ok: true } | { ok: false; message: string };

export type PlanNodeCloser = (request: PlanNodeCloseRequest) => Promise<PlanNodeCloseAnswer>;

/** What the operator asks of a blocked node: open it, against the revision they read. */
export interface PlanNodeOpenRequest {
  nodeId: string;
  expectedRevision: number;
  why?: string;
}

export type PlanNodeOpener = (request: PlanNodeOpenRequest) => Promise<PlanNodeCloseAnswer>;

/** Which form of the rail is open. */
export type PlanNodeChoosing = 'done' | 'dropped' | 'open' | null;

/**
 * The open write's name on a blocked node: **Resume** where the stream's stop
 * blocked it — its note begins `Blocked: ` — and **Approve** otherwise, a
 * proposal or a node a person blocked. The same write either way.
 */
export function openControlLabel(note: string | undefined): 'Approve' | 'Resume' {
  return note?.startsWith('Blocked: ') === true ? 'Resume' : 'Approve';
}

/** The rail's read of the node in full: what the form decides against. */
export interface PlanNodeRead {
  node: PlanNode | undefined;
  error: Error | null;
  refetch: () => unknown;
}

export function isClosedStatus(status: PlanNodeStatus): boolean {
  return status === 'done' || status === 'dropped';
}

const CLOSING_COPY: Record<
  'done' | 'decide' | 'dropped',
  { open: string; field: string; confirm: string }
> = {
  done: { open: 'Mark done', field: 'How its criteria were met', confirm: 'Mark done' },
  decide: {
    open: 'Decide',
    field: 'Your decision — recorded as its outcome',
    confirm: 'Record decision',
  },
  dropped: { open: 'Drop', field: 'Why it is dropped (optional)', confirm: 'Drop' },
};

export function PlanNodeCloseControl({
  node,
  read,
  onClose,
  onOpen,
  choosing,
  onChoose,
}: {
  /** The card's node: its revision is the board's, its children say whether a drop takes a branch. */
  node: PlanTreeNode;
  read: PlanNodeRead;
  onClose: PlanNodeCloser;
  onOpen: PlanNodeOpener;
  /** Which form is open, held by the rail so a card's Decide opens it directly. */
  choosing: PlanNodeChoosing;
  onChoose: (choosing: PlanNodeChoosing) => void;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = read.node;
  const shownClosed = shown !== undefined && isClosedStatus(shown.status);
  const openUnder = node.children.some((child) => !isClosedStatus(child.status));

  const copyFor = (status: 'done' | 'dropped') =>
    CLOSING_COPY[status === 'done' && node.kind === 'decide' ? 'decide' : status];

  const openLabel = openControlLabel(shown?.note);

  if (choosing === null) {
    return (
      <Row gap="xs" align="center">
        {node.status === 'blocked' && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onChoose('open');
            }}
          >
            {openLabel}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onChoose('done');
          }}
        >
          {copyFor('done').open}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChoose('dropped');
          }}
        >
          {openUnder ? 'Drop branch' : copyFor('dropped').open}
        </Button>
      </Row>
    );
  }

  const outcome = text.trim();
  const reset = () => {
    onChoose(null);
    setText('');
    setError(null);
  };

  if (choosing === 'open') {
    const shownOpen = shown !== undefined && shown.status !== 'blocked';
    const submitOpen = async () => {
      if (!shown) return;
      setPending(true);
      setError(null);
      const answer = await onOpen({
        nodeId: node.nodeId,
        expectedRevision: shown.revision,
        ...(outcome.length > 0 ? { why: outcome } : {}),
      });
      setPending(false);
      if (answer.ok) {
        reset();
      } else {
        setError(answer.message);
        void read.refetch();
      }
    };
    return (
      <Column gap="xs" data-plan-open={openLabel}>
        {shown === undefined && read.error === null && (
          <Text size="sm" variant="muted">
            Reading the step…
          </Text>
        )}
        {shown !== undefined && shown.revision !== node.revision && (
          <Text size="xs" variant="muted">
            This step changed since the plan was read; this is how it stands now.
          </Text>
        )}
        {shownOpen && (
          <Text size="sm" tone="danger" role="alert">
            {`This step is ${shown.status} now; reload the plan to see it.`}
          </Text>
        )}
        <Textarea
          aria-label="Why (optional)"
          placeholder="Why (optional) — the note's first line"
          value={text}
          rows={2}
          disabled={pending}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <Text size="xs" variant="muted">
          The resident takes it from here, in its place on the plan.
        </Text>
        {error !== null && (
          <Text size="sm" tone="danger" role="alert">
            {error}
          </Text>
        )}
        <Row gap="xs" align="center">
          <Button
            size="sm"
            variant="primary"
            loading={pending}
            disabled={pending || shown === undefined || shownOpen}
            onClick={() => {
              void submitOpen();
            }}
          >
            {openLabel}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
            Cancel
          </Button>
        </Row>
      </Column>
    );
  }

  const copy = copyFor(choosing);
  const submit = async () => {
    if (!shown) return;
    setPending(true);
    setError(null);
    const answer = await onClose({
      nodeId: node.nodeId,
      expectedRevision: shown.revision,
      status: choosing,
      ...(outcome.length > 0 ? { outcome } : {}),
    });
    setPending(false);
    if (answer.ok) {
      reset();
    } else {
      setError(answer.message);
      // Show the node as it now stands, so a retry is decided against that.
      void read.refetch();
    }
  };

  return (
    <Column gap="xs" data-plan-close={choosing}>
      {shown === undefined && read.error === null && (
        <Text size="sm" variant="muted">
          Reading the step…
        </Text>
      )}
      {shown !== undefined && shown.revision !== node.revision && (
        <Text size="xs" variant="muted">
          This step changed since the plan was read; this is how it stands now.
        </Text>
      )}
      {shownClosed && (
        <Text size="sm" tone="danger" role="alert">
          {`This step is ${shown.status} now; reload the plan to see it.`}
        </Text>
      )}
      <Textarea
        aria-label={copy.field}
        placeholder={copy.field}
        value={text}
        rows={3}
        disabled={pending}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      {choosing === 'dropped' && openUnder && (
        <Text size="xs" variant="muted">
          The open steps under it leave the plan with it.
        </Text>
      )}
      {error !== null && (
        <Text size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
      <Row gap="xs" align="center">
        <Button
          size="sm"
          variant={choosing === 'dropped' ? 'danger' : 'primary'}
          loading={pending}
          disabled={
            pending ||
            shown === undefined ||
            shownClosed ||
            (choosing === 'done' && outcome.length === 0)
          }
          onClick={() => {
            void submit();
          }}
        >
          {choosing === 'dropped' && openUnder ? 'Drop branch' : copy.confirm}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
          Cancel
        </Button>
      </Row>
    </Column>
  );
}
