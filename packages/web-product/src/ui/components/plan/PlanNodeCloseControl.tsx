'use client';

/**
 * The operator's own writes on an open plan node (Plan 322 P3.2), held in the
 * board's rail: mark it done with how its criteria were met — for a `decide`
 * node, the choice — or drop it, and the branch under it with it. The form
 * shows the node as the rail read it when the form opened, and writes against
 * the revision that read showed, whatever the page has read since; a node
 * changed since is refused rather than overwritten, and a refusal reads it
 * again.
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
  /** Absent until the rail's own read, made when it opened, has answered. */
  node: PlanNode | undefined;
  error: Error | null;
  /** Read the node again; answers with the node as it now stands. */
  refetch: () => Promise<PlanNode | undefined>;
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
  // The node as the open form first read it. The page re-reads the plan on
  // every write and run change (Plan 332 D9), so the live read can move under
  // an open form; the write stays pinned to the revision the operator saw.
  const [pinned, setPinned] = useState<PlanNode | undefined>(undefined);
  if (choosing === null) {
    if (pinned !== undefined) setPinned(undefined);
  } else if (pinned === undefined && read.node !== undefined) {
    setPinned(read.node);
  }
  const shown = choosing === null ? read.node : (pinned ?? read.node);
  const movedSinceOpened =
    shown !== undefined && read.node !== undefined && read.node.revision !== shown.revision;
  const closedNow =
    read.node !== undefined && isClosedStatus(read.node.status) ? read.node.status : undefined;
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
      setPinned(await read.refetch());
    }
  };

  return (
    <Column gap="xs" data-plan-close={choosing}>
      {shown === undefined && read.error === null && (
        <Text size="sm" variant="muted">
          Reading the step…
        </Text>
      )}
      {movedSinceOpened ? (
        <Text size="xs" variant="muted" data-plan-close-moved>
          This step changed since this form opened; a write now is refused and shows it as it
          stands.
        </Text>
      ) : (
        shown !== undefined &&
        shown.revision !== node.revision && (
          <Text size="xs" variant="muted">
            This step changed since the plan was read; this is how it stands now.
          </Text>
        )
      )}
      {closedNow !== undefined && (
        <Text size="sm" tone="danger" role="alert">
          {`This step is ${closedNow} now.`}
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
            closedNow !== undefined ||
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
