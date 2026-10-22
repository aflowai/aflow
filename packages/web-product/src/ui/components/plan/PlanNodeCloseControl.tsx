'use client';

/**
 * The operator's own writes on an open plan node (Plan 322 P3.2), held in the
 * board's rail: mark it done with how its criteria were met — for a `decide`
 * node, the choice — or drop it, and the branch under it with it. The form
 * shows the node as the rail read it, on demand, and writes against the
 * revision that read showed; a node changed since is refused rather than
 * overwritten, and a refusal reads it again.
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
  choosing,
  onChoose,
}: {
  /** The card's node: its revision is the board's, its children say whether a drop takes a branch. */
  node: PlanTreeNode;
  read: PlanNodeRead;
  onClose: PlanNodeCloser;
  /** Which form is open, held by the rail so a card's Decide opens it directly. */
  choosing: 'done' | 'dropped' | null;
  onChoose: (choosing: 'done' | 'dropped' | null) => void;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = read.node;
  const shownClosed = shown !== undefined && isClosedStatus(shown.status);
  const openUnder = node.children.some((child) => !isClosedStatus(child.status));

  const copyFor = (status: 'done' | 'dropped') =>
    CLOSING_COPY[status === 'done' && node.kind === 'decide' ? 'decide' : status];

  if (choosing === null) {
    return (
      <Row gap="xs" align="center">
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

  const copy = copyFor(choosing);
  const outcome = text.trim();
  const reset = () => {
    onChoose(null);
    setText('');
    setError(null);
  };
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
