'use client';

/**
 * The operator's open write in the board's rail (Plan 332 D6): **Approve** on
 * a blocked step whose card names the decision it asks (Plan 339 D6),
 * **Resume** on a blocked step that names none, **Reopen** on a closed one,
 * and **Reopen <parent>** on a step
 * stranded under a closed one — each back to `active`, with an optional reason
 * the engine writes into the note. Like the close form, it writes against the
 * revision the rail's own read showed when the form opened, and says when the
 * live read has moved past it.
 *
 * On a blocked step the form is open from the start (Plan 337 P4): its field
 * is the operator's instructions for the work, which the next brief opens
 * with, and **Revise** beside **Approve** sends the same words back as a
 * request to rewrite the proposal, the step left blocked. On a step with a
 * card, Approve also offers an answer to each open question. The answers and
 * the instructions go out as the one `why` of one open write (Plan 337 D3).
 */
import { useState } from 'react';
import { Button, Column, Row, Text, Textarea, Input } from '@aflow/design-system';
import {
  PlanNodeOpenSchema,
  PlanNodeReviseSchema,
  PLAN_NODE_OPEN_WHY_MAX_CHARS,
  type PlanNodeOpen,
  type PlanNodeRevise,
} from '@aflow/schemas';
import {
  usePinnedNode,
  type PlanNodeCloseAnswer,
  type PlanNodeRead,
} from './PlanNodeCloseControl.js';
import { planCardApproveWhy } from '../../lib/plan-card.js';

/** What the operator asks of one node: back to active, against the revision they read. */
export type PlanNodeOpenRequest = PlanNodeOpen & { nodeId: string };

export type PlanNodeOpener = (request: PlanNodeOpenRequest) => Promise<PlanNodeCloseAnswer>;

/** What the operator asks of one blocked node: rewrite it from their note, against the revision they read. */
export type PlanNodeReviseRequest = PlanNodeRevise & { nodeId: string };

export type PlanNodeReviser = (request: PlanNodeReviseRequest) => Promise<PlanNodeCloseAnswer>;

function answerKey(index: number, question: string): string {
  return `${String(index)}\u0000${question}`;
}

/** The approve field: what the words are for, and how they start. */
export const PLAN_APPROVE_FIELD_LABEL = 'Instructions for the work (optional)';
export const PLAN_APPROVE_FIELD_PLACEHOLDER = 'Do it, and make sure…';

export function PlanNodeOpenControl({
  nodeId,
  verb,
  label,
  read,
  onOpen,
  onRevise,
}: {
  /** The node the write opens: the rail's own, or the closed step above a stranded one. */
  nodeId: string;
  verb: 'approve' | 'resume' | 'reopen';
  /** The button: **Approve**, **Resume**, **Reopen**, or **Reopen** and the step it names. */
  label: string;
  read: PlanNodeRead;
  onOpen: PlanNodeOpener;
  /** On an approve: **Revise**, the same words sent back as a request to rewrite. */
  onRevise?: PlanNodeReviser;
}) {
  const [clickedOpen, setOpening] = useState(false);
  // An approve shows its field before the click: the instructions are the point of it.
  const opening = verb === 'approve' || clickedOpen;
  const [text, setText] = useState('');
  /**
   * The operator's answer to each open question of the card, keyed by the
   * question's place and words. A re-pin after a refusal may show a rewritten
   * card, and an answer never moves to a question it was not written for.
   */
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [spend, setSpend] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { shown, movedSinceOpened, setPinned } = usePinnedNode(read, opening);

  if (!opening) {
    return (
      <Row gap="xs" align="center" data-plan-open={verb}>
        <Button
          size="sm"
          variant="secondary"
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
  // On a carded step, Approve answers each open question (Plan 337 D3). One
  // left empty takes its recommended answer, so Approve with no words still
  // records every recommended answer in the note.
  const questions = verb === 'approve' ? (shown?.card?.questions ?? []) : [];
  const answerKeys = questions.map((q, index) => answerKey(index, q.question));
  const openWhy =
    verb === 'approve'
      ? (planCardApproveWhy(
          questions,
          answerKeys.map((key) => answers[key] ?? ''),
          text,
        ) ?? '')
      : why;
  // Revise sends the instructions only, so only their length can refuse it.
  const wordsTooLong = why.length > PLAN_NODE_OPEN_WHY_MAX_CHARS;
  const tooLong = wordsTooLong || openWhy.length > PLAN_NODE_OPEN_WHY_MAX_CHARS;
  const openNow =
    read.node !== undefined && (read.node.status === 'active' || read.node.status === 'waiting')
      ? read.node.status
      : undefined;
  const reset = () => {
    setOpening(false);
    setText('');
    setAnswers({});
    setSpend('');
    setError(null);
  };
  const wordsField = verb === 'approve' ? 'Instructions' : 'Reason';
  const answered = async (answer: Promise<PlanNodeCloseAnswer>) => {
    setPending(true);
    setError(null);
    const settled = await answer;
    if (settled.ok) {
      // The approve form stays open, so it pins the step as its own write left
      // it: a later write, such as the rewrite a Revise asks for, shows as a move.
      if (verb === 'approve') setPinned(await read.refetch());
      setPending(false);
      reset();
    } else {
      setPending(false);
      setError(settled.message);
      setPinned(await read.refetch());
    }
  };
  const revise = async () => {
    if (!shown || onRevise === undefined) return;
    const parsed = PlanNodeReviseSchema.safeParse({ expectedRevision: shown.revision, why });
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map(
            (issue) =>
              `${issue.path[0] === 'why' ? wordsField : 'Step revision'}: ${issue.message}`,
          )
          .join(' '),
      );
      return;
    }
    await answered(onRevise({ nodeId, ...parsed.data }));
  };
  const submit = async () => {
    if (!shown) return;
    const parsed = PlanNodeOpenSchema.safeParse({
      expectedRevision: shown.revision,
      ...(openWhy.length > 0 ? { why: openWhy } : {}),
      ...(spend.trim() !== '' ? { spendCents: Number(spend) } : {}),
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => {
            const field =
              issue.path[0] === 'spendCents'
                ? 'Spend ceiling'
                : issue.path[0] === 'why'
                  ? wordsField
                  : 'Step revision';
            return `${field}: ${issue.message}`;
          })
          .join(' '),
      );
      return;
    }
    await answered(onOpen({ nodeId, ...parsed.data }));
  };
  const field =
    verb === 'approve'
      ? PLAN_APPROVE_FIELD_LABEL
      : verb === 'resume'
        ? 'Why it resumes (optional)'
        : 'Why it is reopened (optional)';
  const words = (
    <Textarea
      aria-label={field}
      placeholder={verb === 'approve' ? PLAN_APPROVE_FIELD_PLACEHOLDER : field}
      value={text}
      rows={verb === 'approve' ? 3 : 2}
      disabled={pending}
      onChange={(event) => {
        setText(event.target.value);
      }}
    />
  );
  const blocked = pending || shown === undefined || tooLong;

  return (
    <Column gap="xs" data-plan-open={verb} data-plan-open-form>
      {shown === undefined && read.error === null && (
        <Text size="sm" variant="muted">
          Reading the step…
        </Text>
      )}
      {movedSinceOpened && !pending && (
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
      {questions.length > 0 && (
        <Column gap="xs" data-plan-approve-questions>
          <Text size="xs" weight="medium">
            Answers to the open questions (optional)
          </Text>
          {questions.map((q, index) => (
            <Column gap="xs" key={index} data-plan-approve-question={index}>
              <Text size="sm" color="secondary">
                {q.question}
              </Text>
              <Input
                aria-label={`Answer to question ${String(index + 1)}`}
                placeholder={`Recommended: ${q.recommended}`}
                disabled={pending}
                value={answers[answerKey(index, q.question)] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setAnswers((held) => ({ ...held, [answerKey(index, q.question)]: value }));
                }}
              />
            </Column>
          ))}
          <Text size="xs" variant="muted" data-plan-approve-answers-hint>
            An empty answer takes the recommended answer. Approve writes each question and its
            answer into the note, on the Approved: line.
          </Text>
        </Column>
      )}
      {verb === 'approve' && (
        <>
          <Text size="xs" weight="medium">
            {field}
          </Text>
          {words}
          <Text size="xs" variant="muted" data-plan-approve-hint>
            {(questions.length > 0
              ? 'Approve starts the work. Its brief opens with the answers, and then with these words.'
              : 'Approve starts the work, and its brief opens with these words.') +
              (onRevise !== undefined
                ? ' Revise keeps the step blocked and asks the Helmsman to rewrite it from these words.'
                : '')}
          </Text>
        </>
      )}
      <Input
        aria-label="Spend ceiling (cents, optional)"
        placeholder="Spend ceiling (cents, optional)"
        type="number"
        disabled={pending}
        value={spend}
        onChange={(event) => {
          setSpend(event.target.value);
        }}
      />
      {verb !== 'approve' && words}
      <Text size="xs" variant="muted">
        Leave the ceiling blank to keep it. Opening starts a fresh spend window.
      </Text>
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
          disabled={blocked || openNow !== undefined}
          onClick={() => {
            void submit();
          }}
        >
          {label}
        </Button>
        {onRevise !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            disabled={
              pending ||
              shown === undefined ||
              wordsTooLong ||
              why.length === 0 ||
              shown.status !== 'blocked'
            }
            onClick={() => {
              void revise();
            }}
          >
            Revise
          </Button>
        )}
        {verb !== 'approve' && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
            Cancel
          </Button>
        )}
      </Row>
    </Column>
  );
}
