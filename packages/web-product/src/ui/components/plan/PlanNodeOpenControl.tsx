'use client';

/**
 * The operator's open write in the board's rail (Plan 332 D6): **Approve** on
 * a blocked step, **Reopen** on a closed one, and **Reopen <parent>** on a step
 * stranded under a closed one — each back to `active`, with an optional reason
 * the engine writes into the note. Like the close form, it writes against the
 * revision the rail's own read showed when the form opened, and says when the
 * live read has moved past it.
 */
import { useState } from 'react';
import { Button, Column, Row, Text, Textarea } from '@aflow/design-system';
import { PLAN_NODE_OPEN_WHY_MAX_CHARS } from '@aflow/schemas';
import {
  usePinnedNode,
  type PlanNodeCloseAnswer,
  type PlanNodeRead,
} from './PlanNodeCloseControl.js';

/** What the operator asks of one node: back to active, against the revision they read. */
export interface PlanNodeOpenRequest {
  nodeId: string;
  expectedRevision: number;
  why?: string;
}

export type PlanNodeOpener = (request: PlanNodeOpenRequest) => Promise<PlanNodeCloseAnswer>;

export function PlanNodeOpenControl({
  nodeId,
  verb,
  label,
  read,
  onOpen,
}: {
  /** The node the write opens: the rail's own, or the closed step above a stranded one. */
  nodeId: string;
  verb: 'approve' | 'reopen';
  /** The button: **Approve**, **Reopen**, or **Reopen** and the step it names. */
  label: string;
  read: PlanNodeRead;
  onOpen: PlanNodeOpener;
}) {
  const [opening, setOpening] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { shown, movedSinceOpened, setPinned } = usePinnedNode(read, opening);

  if (!opening) {
    return (
      <Row gap="xs" align="center" data-plan-open={verb}>
        <Button
          size="sm"
          variant={verb === 'approve' ? 'primary' : 'secondary'}
          onClick={() => {
            setOpening(true);
          }}
        >
          {label}
        </Button>
      </Row>
    );
  }

  const why = text.trim();
  const tooLong = why.length > PLAN_NODE_OPEN_WHY_MAX_CHARS;
  const openNow =
    read.node !== undefined && (read.node.status === 'active' || read.node.status === 'waiting')
      ? read.node.status
      : undefined;
  const reset = () => {
    setOpening(false);
    setText('');
    setError(null);
  };
  const submit = async () => {
    if (!shown) return;
    setPending(true);
    setError(null);
    const answer = await onOpen({
      nodeId,
      expectedRevision: shown.revision,
      ...(why.length > 0 ? { why } : {}),
    });
    setPending(false);
    if (answer.ok) {
      reset();
    } else {
      setError(answer.message);
      setPinned(await read.refetch());
    }
  };
  const field =
    verb === 'approve'
      ? 'Why it is approved (optional) — the first line of its note'
      : 'Why it is reopened (optional)';

  return (
    <Column gap="xs" data-plan-open={verb} data-plan-open-form>
      {shown === undefined && read.error === null && (
        <Text size="sm" variant="muted">
          Reading the step…
        </Text>
      )}
      {movedSinceOpened && (
        <Text size="xs" variant="muted" data-plan-open-moved>
          This step changed since this form opened; a write now is refused and shows it as it
          stands.
        </Text>
      )}
      {openNow !== undefined && (
        <Text size="sm" tone="danger" role="alert">
          {`This step is ${openNow} now.`}
        </Text>
      )}
      <Textarea
        aria-label={field}
        placeholder={field}
        value={text}
        rows={2}
        disabled={pending}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      {tooLong && (
        <Text size="xs" tone="danger">
          {`At most ${String(PLAN_NODE_OPEN_WHY_MAX_CHARS)} characters.`}
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
          variant="primary"
          loading={pending}
          disabled={pending || shown === undefined || openNow !== undefined || tooLong}
          onClick={() => {
            void submit();
          }}
        >
          {label}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
          Cancel
        </Button>
      </Row>
    </Column>
  );
}
