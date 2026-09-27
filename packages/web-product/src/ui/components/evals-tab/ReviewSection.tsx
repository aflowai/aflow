'use client';

/**
 * REVIEW — the label-queue bench, the human half of an eval.
 *
 * One item at full attention: the QUESTION (the criterion under judgement) and
 * the MATERIAL (exactly the evidence the judge received), never the answer.
 * The judge's verdict, score and rationale are withheld because a suggested
 * label anchors the labeler — and so are the stream fields that imply them
 * (`partition`, `source`, `inclusionProbability`), each of which names the
 * judge's verdict exactly. Showing the evidence is the other half of the same
 * invariant: a scorecard measures judge-vs-human agreement, so a human marking
 * from different material than the judge saw confounds the confusion matrix
 * and precision/recall/kappa stop describing the judge. When the replay cannot
 * reproduce the judge's material, the item says so rather than presenting a
 * narrower pack as the whole.
 *
 * The bench is a flow, not a list. Queue items are anonymous replicates — no
 * one chooses "trial 3" from two hundred rows — so nothing enumerates them:
 * marking advances, arrows skip, a counter says where the walk is, and the
 * one navigable structure (the handful of cases) is a jump control that stays
 * the same size at any queue length.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import {
  Accordion,
  Badge,
  Button,
  Card,
  Column,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  JsonViewer,
  KeyHint,
  Row,
  ScrollArea,
  Select,
  Spacer,
  Spinner,
  Text,
  Textarea,
  Tooltip,
  useMediaQuery,
  type AccordionItemData,
} from '@aflow/design-system';

import { MarkdownRenderer } from '../markdown-renderer.js';
import { useApiMutation, useApiQuery } from '../../hooks/useApiQuery.js';
import type { LabelQueueItem, LabelQueueResponse } from './evalsApi.js';
import { evalsKeys } from './evalsApi.js';
import type { JudgeEvidenceBlock, SubmitFailure } from './evalsDerive.js';
import {
  deriveEvidenceRender,
  deriveItemReadability,
  deriveJudgeEvidenceView,
  deriveQueuePosition,
  deriveReviewQueue,
  deriveRubricQuestionView,
  deriveSubmitFailure,
  deriveSubmitGate,
  formatEvidencePreview,
  readApiErrorCode,
  summariseUnreadable,
} from './evalsDerive.js';
import {
  evidencePreStyle,
  INSPECTOR_MAX_HEIGHT_CSS,
  REVIEW_CRITERION_QUERY,
  REVIEW_CRITERION_WIDTH,
} from './evalsStyles.js';

/** Quoted reading ground — the same bands chat renders an exchange with. */
const QUOTED = 'var(--color-surface-quoted)';
const QUOTED_ALT = 'var(--color-surface-quoted-alt)';
const HAIRLINE = '1px solid var(--color-border-subtle)';

/** The reading measure — long replies stay legible instead of spanning the pane. */
const READING_MAX_WIDTH = 820;

const PURPOSE_SENTENCE = 'Marks grade the automatic judges. They never change a run’s result.';

const SHORTCUTS: ReadonlyArray<{ keys: string[]; does: string }> = [
  { keys: ['P'], does: 'Mark the reply as passing' },
  { keys: ['F'], does: 'Mark the reply as failing' },
  { keys: ['J', '↓'], does: 'Next item' },
  { keys: ['K', '↑'], does: 'Previous item' },
  { keys: ['R'], does: 'Write the reason' },
  { keys: ['Esc'], does: 'Leave the reason box' },
  { keys: ['X'], does: 'Discard the item, after a confirm' },
  { keys: ['?'], does: 'These shortcuts' },
];

/** The app's small-caps section label, as the designer's field labels use it. */
const overlineStyle = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--color-text-muted)',
} as const;

function Overline({ children }: { children: ReactNode }) {
  return <span style={overlineStyle}>{children}</span>;
}

// ============================================================================
// Controls — jump by case, step by item; never a judgement affordance
// ============================================================================

function ControlsRow({
  groups,
  open,
  position,
  total,
  marked,
  onOpen,
  onStep,
}: {
  groups: ReturnType<typeof deriveReviewQueue>['groups'];
  open: LabelQueueItem;
  position: number;
  total: number;
  marked: number;
  onOpen: (id: string) => void;
  onStep: (delta: number) => void;
}) {
  const activeGroup =
    groups.find((group) => group.items.some((item) => item.id === open.id)) ?? groups[0];
  const done = marked;
  const fraction = done + total === 0 ? 0 : done / (done + total);

  return (
    <Row gap="sm" align="center" wrap>
      <Text size="xs" color="muted" id="review-case-label" style={{ flex: 'none' }}>
        Case
      </Text>
      <Select
        value={activeGroup?.caseTitle ?? ''}
        onChange={(event) => {
          const first = groups.find((group) => group.caseTitle === event.target.value)?.items[0];
          if (first !== undefined) onOpen(first.id);
        }}
        aria-labelledby="review-case-label"
        style={{ maxWidth: 420, minWidth: 200 }}
      >
        {groups.map((group) => (
          <option key={group.caseTitle} value={group.caseTitle}>
            {group.caseTitle} · {group.items.length}
          </option>
        ))}
      </Select>
      <Spacer />
      {marked > 0 && (
        <Row gap="xs" align="center" style={{ flex: 'none' }}>
          <Text size="xs" color="secondary">
            {marked} marked
          </Text>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={done + total}
            aria-valuenow={done}
            aria-label="Marked this session"
            style={{
              width: 72,
              height: 3,
              borderRadius: 999,
              background: QUOTED_ALT,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${String(fraction * 100)}%`,
                background: 'var(--color-interactive-default)',
                transition: 'width 200ms ease',
              }}
            />
          </div>
        </Row>
      )}
      <Row gap="xs" align="center" style={{ flex: 'none' }}>
        <IconButton
          icon={<Icon name="caret-left" size="sm" />}
          size="sm"
          aria-label="Previous item"
          disabled={position === 0}
          onClick={() => {
            onStep(-1);
          }}
        />
        <Text size="sm" color="secondary" style={{ minWidth: 64, textAlign: 'center' }}>
          {position + 1} of {total}
        </Text>
        <IconButton
          icon={<Icon name="caret-right" size="sm" />}
          size="sm"
          aria-label="Next item"
          disabled={position >= total - 1}
          onClick={() => {
            onStep(1);
          }}
        />
      </Row>
      <Tooltip content={PURPOSE_SENTENCE} side="left" wrap>
        <IconButton icon={<Icon name="info" size="sm" />} size="sm" aria-label="What marks do" />
      </Tooltip>
    </Row>
  );
}

// ============================================================================
// Material — the exchange, as one card
// ============================================================================

/**
 * Full-width turn bands, not bubbles — a long reply in a narrow bubble is
 * unreadable. The reply is the protagonist: it is what the verdict is about,
 * so the customer turn reads as its context, not its equal.
 */
function ExchangeCard({ item }: { item: LabelQueueItem }) {
  const evidence = item.evidence?.status === 'available' ? item.evidence : undefined;
  const conversation = evidence?.conversation;
  const caveats: string[] = [];
  if (evidence?.conversationOnly === true) {
    caveats.push(
      'The run has since been cleaned up. This is the exchange saved when the item was created — the judge read more than this.',
    );
  }
  const evidenceWarning = deriveJudgeEvidenceView(item.evidence).warning;
  if (evidenceWarning !== null) caveats.push(evidenceWarning);

  return (
    <Card style={{ padding: 0 }}>
      <Row
        gap="sm"
        align="center"
        style={{ padding: 'var(--space-2) var(--space-3)', borderBottom: HAIRLINE }}
      >
        <Overline>The exchange</Overline>
        <Spacer />
        <Text size="xs" color="secondary">
          trial {item.trial}
        </Text>
      </Row>
      {caveats.length > 0 && (
        <Row
          gap="sm"
          align="start"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--color-warning-bg)',
            borderBottom: HAIRLINE,
          }}
        >
          <span style={{ flex: 'none', color: 'var(--color-warning-fg)', display: 'inline-flex' }}>
            <Icon name="warning" size="sm" />
          </span>
          <Column gap="xs">
            {caveats.map((caveat) => (
              <Text key={caveat} size="xs" style={{ color: 'var(--color-warning-text)' }}>
                {caveat}
              </Text>
            ))}
          </Column>
        </Row>
      )}
      {conversation?.request != null && (
        <Column
          gap="xs"
          style={{ padding: 'var(--space-3)', background: QUOTED_ALT, borderBottom: HAIRLINE }}
        >
          <Overline>Customer</Overline>
          <MarkdownRenderer content={conversation.request} />
        </Column>
      )}
      <Column gap="xs" style={{ padding: 'var(--space-3) var(--space-3) var(--space-4)' }}>
        <Overline>Agent reply</Overline>
        {conversation?.reply != null ? (
          <MarkdownRenderer content={conversation.reply} />
        ) : (
          <Text size="sm" color="secondary">
            This trial produced no reply to read.
          </Text>
        )}
      </Column>
      <ToolResults item={item} />
      <EvidencePack item={item} />
    </Card>
  );
}

/**
 * What the tools returned, because the judge is shown it too.
 *
 * A label scored against a narrower pack than the judge read measures the gap
 * in evidence rather than the judge — and "is this stated fact supported" is
 * precisely the question these labels exist to settle.
 */
function ToolResults({ item }: { item: LabelQueueItem }) {
  const results = item.evidence?.status === 'available' ? item.evidence.toolResults : undefined;
  if (results === undefined || results.length === 0) return null;
  return (
    <Column gap="xs">
      <Text size="xs" weight="semibold" color="muted">
        What the tools returned · {results.length} {results.length === 1 ? 'call' : 'calls'}
      </Text>
      <Accordion
        multiple
        items={results.map((call): AccordionItemData => ({
          id: `tool-${String(call.sequence)}-${call.endpointId}`,
          title: `${call.endpointId} → ${String(call.status)}`,
          children: <pre style={evidencePreStyle}>{call.body}</pre>,
        }))}
      />
    </Column>
  );
}

function EvidenceBlockBody({ block }: { block: JudgeEvidenceBlock }) {
  const [raw, setRaw] = useState(false);
  const render = deriveEvidenceRender(block);
  if (render.kind === 'text') {
    return <pre style={evidencePreStyle}>{block.content}</pre>;
  }
  return (
    <Column gap="xs">
      <Row justify="end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setRaw(!raw);
          }}
        >
          {raw ? 'Show tree' : 'Show raw'}
        </Button>
      </Row>
      {raw ? (
        <pre style={evidencePreStyle}>{block.content}</pre>
      ) : (
        <JsonViewer
          data={render.value}
          collapsed={false}
          collapseDepth={2}
          maxHeight={INSPECTOR_MAX_HEIGHT_CSS}
          copyable
        />
      )}
    </Column>
  );
}

/** The judge's own pack, closed by default but above the decision — the scorecard only measures the judge if both sides read the same material. */
function EvidencePack({ item }: { item: LabelQueueItem }) {
  const view = deriveJudgeEvidenceView(item.evidence);
  if (view.blocks.length === 0) {
    return view.note === null ? null : (
      <Column style={{ padding: '0 var(--space-3) var(--space-3)' }}>
        <Text size="xs" color="secondary">
          {view.note}
        </Text>
      </Column>
    );
  }
  return (
    <Column gap="xs" style={{ padding: '0 var(--space-3) var(--space-3)' }}>
      <Overline>
        What the judge was given · {view.blocks.length}{' '}
        {view.blocks.length === 1 ? 'block' : 'blocks'}
      </Overline>
      <Accordion
        multiple
        style={{ border: HAIRLINE }}
        items={view.blocks.map((block, index): AccordionItemData => {
          const render = deriveEvidenceRender(block);
          return {
            id: `evidence-${String(index)}`,
            title: block.label,
            subtitle: formatEvidencePreview(block),
            ...(render.kind === 'json' ? { badge: <Badge variant="neutral">json</Badge> } : {}),
            children: <EvidenceBlockBody block={block} />,
          };
        })}
      />
    </Column>
  );
}

// ============================================================================
// Criterion — the standard, persistent, never behind a disclosure
// ============================================================================

function CriterionCard({ item }: { item: LabelQueueItem }) {
  const view = deriveRubricQuestionView(item);
  return (
    <Card style={{ padding: 'var(--space-3)' }}>
      <Column gap="sm">
        <Overline>What counts as a pass</Overline>
        <Text size="sm" weight="semibold">
          {view.title}
        </Text>
        {view.entries.map((entry, index) => (
          <Column key={`${String(index)}|${entry.criterion}`} gap="none">
            <Text size="sm">
              {index + 1}. {entry.criterion}
            </Text>
            <Text size="xs" color="secondary">
              {entry.description}
            </Text>
          </Column>
        ))}
        {view.referenceAnswer !== null && (
          <Column
            gap="xs"
            style={{
              padding: 'var(--space-2) var(--space-3)',
              background: QUOTED,
              border: HAIRLINE,
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Overline>Reference answer</Overline>
            <Text size="xs" color="secondary">
              {view.referenceAnswer}
            </Text>
          </Column>
        )}
        {view.note !== null && (
          <Text size="xs" tone="danger">
            {view.note}
          </Text>
        )}
        {view.warning !== null && (
          <Text size="xs" tone="danger">
            {view.warning}
          </Text>
        )}
      </Column>
    </Card>
  );
}

// ============================================================================
// Un-reviewable items — a clearing banner, only when the pile exists
// ============================================================================

/**
 * Clearing is sequential on purpose — two hundred parallel writes is a herd —
 * so it reports where it has got to and can be stopped, and a partial failure
 * is one tallied line rather than one toast per item.
 */
function UnreadableBanner({
  spaceId,
  items,
  onCleared,
}: {
  spaceId: string;
  items: LabelQueueItem[];
  onCleared: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);
  const [failed, setFailed] = useState(0);
  const stopRef = useRef(false);

  const dismiss = useApiMutation<{ itemId: string }>({
    path: ({ itemId }) => `/spaces/${spaceId}/eval-label-queue/${itemId}/dismiss`,
    method: 'POST',
    spaceId,
    invalidate: [evalsKeys.labelQueue(spaceId)],
    onError: () => {
      // Tallied below instead: clearing forty of these raises forty toasts.
    },
  });

  const reasons = [
    ...new Set(items.map((item) => deriveItemReadability(item).reason ?? '')),
  ].filter((reason) => reason !== '');

  const clearAll = async () => {
    setConfirmOpen(false);
    stopRef.current = false;
    setCleared(0);
    setFailed(0);
    let done = 0;
    let rejected = 0;
    for (const item of items) {
      if (stopRef.current) break;
      try {
        await dismiss.mutateAsync({ itemId: item.id });
        onCleared(item.id);
      } catch {
        rejected += 1;
        setFailed(rejected);
      }
      done += 1;
      setCleared(done);
    }
    setCleared(null);
  };

  const running = cleared !== null;

  return (
    <Card style={{ padding: 'var(--space-3)' }}>
      <Row gap="sm" align="start">
        <span style={{ flex: 'none', color: 'var(--color-warning-fg)', display: 'inline-flex' }}>
          <Icon name="warning" size="sm" />
        </span>
        <Column gap="xs" style={{ minWidth: 0 }}>
          <Text size="sm" weight="semibold">
            {items.length} can’t be read
          </Text>
          {reasons.map((reason) => (
            <Text key={reason} size="xs" color="secondary">
              {reason}
            </Text>
          ))}
          <Text size="xs" color="secondary">
            {summariseUnreadable(items)}
          </Text>
          {failed > 0 && !running && (
            <Text size="xs" tone="danger">
              {failed} could not be cleared.
            </Text>
          )}
        </Column>
        <Spacer />
        {running ? (
          <Row gap="sm" align="center" style={{ flex: 'none' }}>
            <Text size="xs" color="secondary">
              Cleared {cleared} of {items.length}…
            </Text>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                stopRef.current = true;
              }}
            >
              Stop
            </Button>
          </Row>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            style={{ flex: 'none' }}
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            Clear all {items.length}
          </Button>
        )}
      </Row>
      <Dialog
        open={confirmOpen}
        onClose={() => {
          setConfirmOpen(false);
        }}
        title={`Clear ${String(items.length)} items?`}
        width="sm"
        footer={
          <Row gap="sm" justify="end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
              }}
            >
              Keep them
            </Button>
            <Button variant="danger" size="sm" autoFocus onClick={() => void clearAll()}>
              Clear them
            </Button>
          </Row>
        }
      >
        <Text size="sm" color="secondary">
          Clearing removes them from the queue for good. None of them can be read, so none of them
          can be scored.
        </Text>
      </Dialog>
    </Card>
  );
}

// ============================================================================
// Verdict dock — the one place a decision is recorded
// ============================================================================

/**
 * The two verdicts carry equal weight — two outcomes of one decision, told
 * apart by word and leading bar, never by colour alone. Discard is the
 * irreversible one: there is no un-dismiss route, so it sits away from the
 * verdict pair and costs a confirm. Marking is the reversible one and stays a
 * single keystroke.
 */
function VerdictDock({
  critique,
  onCritique,
  reasonRef,
  gate,
  onSubmit,
  onDiscard,
  onShortcuts,
  failure,
  onMoveOn,
  pending,
  readable,
}: {
  critique: string;
  onCritique: (value: string) => void;
  reasonRef: React.RefObject<HTMLTextAreaElement | null>;
  gate: { canSubmit: boolean; hint: string | null };
  onSubmit: (verdict: 'pass' | 'fail') => void;
  onDiscard: () => void;
  onShortcuts: () => void;
  failure: SubmitFailure | null;
  onMoveOn: () => void;
  pending: boolean;
  readable: boolean;
}) {
  return (
    <Column gap="sm" style={{ flex: 'none', paddingTop: 'var(--space-3)', borderTop: HAIRLINE }}>
      <Row align="center" gap="sm">
        <Text size="sm" weight="semibold">
          Does the reply pass?
        </Text>
        {gate.hint !== null && (
          <Text size="xs" color="secondary">
            {gate.hint}
          </Text>
        )}
        <Spacer />
        <Button variant="ghost" size="sm" disabled={pending} onClick={onDiscard}>
          Discard <KeyHint>X</KeyHint>
        </Button>
        <Button variant="ghost" size="sm" onClick={onShortcuts} aria-label="Keyboard shortcuts">
          <KeyHint>?</KeyHint>
        </Button>
      </Row>
      <Row gap="sm" align="stretch" wrap>
        <div style={{ flex: '1 1 320px', minWidth: 0, position: 'relative' }}>
          <Textarea
            ref={reasonRef}
            value={critique}
            onChange={(event) => {
              onCritique(event.target.value);
            }}
            placeholder="Why — in plain words"
            rows={2}
            disabled={pending || !readable}
            aria-label="Reason for the mark"
            style={{ width: '100%', height: '100%', resize: 'none' }}
          />
          <span style={{ position: 'absolute', top: 6, right: 8, pointerEvents: 'none' }}>
            <KeyHint>R</KeyHint>
          </span>
        </div>
        <Row gap="sm" align="stretch" style={{ flex: 'none' }}>
          <Button
            variant="secondary"
            onClick={() => {
              onSubmit('pass');
            }}
            disabled={!gate.canSubmit}
            style={{ minWidth: 104, borderLeft: '3px solid var(--color-success-default)' }}
          >
            Pass <KeyHint>P</KeyHint>
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onSubmit('fail');
            }}
            disabled={!gate.canSubmit}
            style={{ minWidth: 104, borderLeft: '3px solid var(--color-danger-default)' }}
          >
            Fail <KeyHint>F</KeyHint>
          </Button>
        </Row>
      </Row>
      {failure !== null && (
        <Row gap="sm" align="center" wrap>
          <Text size="xs" tone="danger">
            {failure.text}
          </Text>
          {failure.stranded && (
            <Button variant="secondary" size="sm" onClick={onMoveOn}>
              Move on
            </Button>
          )}
        </Row>
      )}
    </Column>
  );
}

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width="sm">
      <Column gap="sm">
        {SHORTCUTS.map((entry) => (
          <Row key={entry.does} gap="sm" align="center">
            <Row gap="xs" style={{ flex: 'none', width: 72 }}>
              {entry.keys.map((key) => (
                <KeyHint key={key}>{key}</KeyHint>
              ))}
            </Row>
            <Text size="sm" color="secondary">
              {entry.does}
            </Text>
          </Row>
        ))}
      </Column>
    </Dialog>
  );
}

// ============================================================================
// The bench
// ============================================================================

/**
 * One item at full attention, a decision, and the next one in place.
 */
function ReviewBench({ spaceId, items }: { spaceId: string; items: LabelQueueItem[] }) {
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [marked, setMarked] = useState(0);
  const [openId, setOpenId] = useState('');
  const [critique, setCritique] = useState('');
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const regionRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const criterionInline = useMediaQuery(REVIEW_CRITERION_QUERY);

  const visible = useMemo(() => items.filter((item) => !resolved.has(item.id)), [items, resolved]);
  const queue = useMemo(() => deriveReviewQueue(visible), [visible]);
  const position = deriveQueuePosition(queue.order, openId);
  const open = position?.item ?? null;

  useEffect(() => {
    regionRef.current?.focus({ preventScroll: true });
  }, [open?.id]);

  const openItem = useCallback((id: string) => {
    setOpenId(id);
    setCritique('');
    setFailure(null);
  }, []);

  const strike = useCallback(
    (id: string) => {
      const index = queue.order.findIndex((item) => item.id === id);
      const next = queue.order[index + 1] ?? queue.order[index - 1];
      setResolved((prev) => new Set(prev).add(id));
      openItem(next?.id ?? '');
    },
    [queue.order, openItem],
  );

  const labelMutation = useApiMutation<{
    itemId: string;
    verdict: 'pass' | 'fail';
    critique: string;
  }>({
    path: ({ itemId }) => `/spaces/${spaceId}/eval-label-queue/${itemId}/label`,
    method: 'POST',
    spaceId,
    invalidate: [evalsKeys.labelQueue(spaceId)],
    serialize: ({ verdict, critique: reason }) => JSON.stringify({ verdict, critique: reason }),
    onSuccess: (_output, input) => {
      setMarked((count) => count + 1);
      strike(input.itemId);
    },
    onError: (error) => {
      setFailure(
        deriveSubmitFailure({
          status: error.status,
          code: readApiErrorCode(error.body),
          message: error.message,
        }),
      );
    },
  });
  const dismissMutation = useApiMutation<{ itemId: string }>({
    path: ({ itemId }) => `/spaces/${spaceId}/eval-label-queue/${itemId}/dismiss`,
    method: 'POST',
    spaceId,
    invalidate: [evalsKeys.labelQueue(spaceId)],
    serialize: () => JSON.stringify({}),
    onSuccess: (_output, input) => {
      strike(input.itemId);
    },
    onError: (error) => {
      setFailure(
        deriveSubmitFailure({
          status: error.status,
          code: readApiErrorCode(error.body),
          message: error.message,
        }),
      );
    },
  });

  const pending = labelMutation.isPending || dismissMutation.isPending;
  const readable = open !== null && deriveItemReadability(open).readable;
  const gate = deriveSubmitGate({ critique, pending, readable });

  const submit = useCallback(
    (verdict: 'pass' | 'fail') => {
      if (open === null || !gate.canSubmit) return;
      setFailure(null);
      labelMutation.mutate({ itemId: open.id, verdict, critique: critique.trim() });
    },
    [open, gate.canSubmit, critique, labelMutation],
  );

  const step = (delta: number) => {
    if (position === null) return;
    const next = queue.order[position.index + delta];
    if (next !== undefined) openItem(next.id);
  };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
      if (event.key === 'Escape') regionRef.current?.focus({ preventScroll: true });
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'p' || key === 'f') {
      if (!gate.canSubmit) return;
      event.preventDefault();
      submit(key === 'p' ? 'pass' : 'fail');
      return;
    }
    if (key === 'j' || key === 'arrowdown') {
      event.preventDefault();
      step(1);
      return;
    }
    if (key === 'k' || key === 'arrowup') {
      event.preventDefault();
      step(-1);
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      reasonRef.current?.focus();
      return;
    }
    if (key === 'x' && open !== null) {
      event.preventDefault();
      setDiscardOpen(true);
      return;
    }
    if (key === '?') {
      event.preventDefault();
      setKeysOpen((shown) => !shown);
    }
  };

  const banner =
    queue.unavailable.length > 0 ? (
      <UnreadableBanner
        spaceId={spaceId}
        items={queue.unavailable}
        onCleared={(id) => {
          setResolved((prev) => new Set(prev).add(id));
        }}
      />
    ) : null;

  if (open === null) {
    return (
      <Column gap="md" style={{ height: '100%', minHeight: 0, padding: 'var(--space-3) 0' }}>
        {banner !== null ? (
          <Column gap="md" style={{ maxWidth: READING_MAX_WIDTH }}>
            {banner}
          </Column>
        ) : (
          <Row justify="center" align="center" style={{ flex: 1 }}>
            <EmptyState
              icon={<Icon name="check" size="lg" />}
              title="All caught up"
              description={`Finished runs send a sample of replies here for a human check. ${PURPOSE_SENTENCE}`}
            />
          </Row>
        )}
      </Column>
    );
  }

  const criterion = <CriterionCard item={open} />;

  return (
    /*
      Focused on arrival and on every item change so the verdict keys are live
      without a click, and kept out of the tab order so the panel is not one
      giant tab stop — the controls inside it are the tab stops, and a
      keystroke on any of them still bubbles here.
    */
    <Column
      gap="sm"
      ref={regionRef}
      tabIndex={-1}
      onKeyDown={onKey}
      role="group"
      aria-label="Review bench"
      style={{ height: '100%', minHeight: 0, outline: 'none', padding: 'var(--space-3) 0' }}
    >
      <ControlsRow
        groups={queue.groups}
        open={open}
        position={position?.index ?? 0}
        total={queue.order.length}
        marked={marked}
        onOpen={openItem}
        onStep={step}
      />

      <Row gap="md" align="stretch" style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea grow style={{ minWidth: 0 }}>
          <Column gap="md" style={{ maxWidth: READING_MAX_WIDTH }}>
            {banner}
            {criterionInline && criterion}
            <ExchangeCard item={open} />
          </Column>
        </ScrollArea>
        {!criterionInline && (
          <ScrollArea grow style={{ flex: 'none', width: REVIEW_CRITERION_WIDTH }}>
            {criterion}
          </ScrollArea>
        )}
      </Row>

      <VerdictDock
        critique={critique}
        onCritique={setCritique}
        reasonRef={reasonRef}
        gate={gate}
        onSubmit={submit}
        onDiscard={() => {
          setDiscardOpen(true);
        }}
        onShortcuts={() => {
          setKeysOpen(true);
        }}
        failure={failure}
        onMoveOn={() => {
          strike(open.id);
        }}
        pending={pending}
        readable={readable}
      />

      <ShortcutsDialog
        open={keysOpen}
        onClose={() => {
          setKeysOpen(false);
        }}
      />

      <Dialog
        open={discardOpen}
        onClose={() => {
          setDiscardOpen(false);
        }}
        title="Discard this item?"
        width="sm"
        footer={
          <Row gap="sm" justify="end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setDiscardOpen(false);
              }}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              size="sm"
              autoFocus
              onClick={() => {
                setDiscardOpen(false);
                setFailure(null);
                dismissMutation.mutate({ itemId: open.id });
              }}
            >
              Discard item
            </Button>
          </Row>
        }
      >
        <Text size="sm" color="secondary">
          Discarding removes the item from the queue for good. It is not scored, and it does not
          come back.
        </Text>
      </Dialog>
    </Column>
  );
}

// ============================================================================
// Section
// ============================================================================

export function ReviewSection({
  spaceId,
  workflowSlug,
}: {
  spaceId: string;
  /** The tab is per-skill — the queue lists only this skill's items. */
  workflowSlug: string;
}) {
  const queueQuery = useApiQuery<LabelQueueResponse>({
    key: evalsKeys.labelQueue(spaceId, workflowSlug),
    path: `/spaces/${spaceId}/eval-label-queue?status=pending&workflowSlug=${encodeURIComponent(workflowSlug)}`,
    spaceId,
    staleTime: 30_000,
  });
  const operatorOnly = queueQuery.error?.status === 403;
  const queueLoadError = !operatorOnly && queueQuery.data === undefined ? queueQuery.error : null;
  const items = queueQuery.data?.items ?? [];

  const frame = (body: ReactNode) => (
    <Row justify="center" align="center" style={{ height: '100%', padding: 'var(--space-6)' }}>
      {body}
    </Row>
  );

  if (operatorOnly) {
    return frame(
      <EmptyState
        icon={<Icon name="lock" size="lg" />}
        title="Marking is for operators"
        description="This account cannot record marks here."
      />,
    );
  }
  if (queueLoadError !== null) {
    return frame(
      <Column gap="sm" style={{ alignItems: 'center', textAlign: 'center' }}>
        <Text size="sm" tone="danger">
          The queue could not be read — pending items are not shown. {queueLoadError.message}
        </Text>
        <Button variant="secondary" size="sm" onClick={() => void queueQuery.refetch()}>
          Retry
        </Button>
      </Column>,
    );
  }
  if (queueQuery.isLoading) {
    return frame(<Spinner size="sm" label="Loading the queue" />);
  }
  if (items.length === 0) {
    return frame(
      <EmptyState
        icon={<Icon name="check" size="lg" />}
        title="All caught up"
        description={`Finished runs send a sample of replies here for a human check. ${PURPOSE_SENTENCE}`}
      />,
    );
  }

  return <ReviewBench spaceId={spaceId} items={items} />;
}
