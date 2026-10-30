'use client';

/**
 * The space's plan (Plan 322 P3.3, Plan 332): the plans as a list, each with
 * its state (D2, D3), beside the overview — the Needs you, In flight and Up
 * next lanes across every open plan (D1, D7), where the page lands — or the
 * chosen plan's board — its header, five columns saying what the loop is
 * doing with each step (D4), a card per step carrying labels only. One side
 * rail serves both: it reads a step on demand and holds the operator's own
 * controls — mark done, decide, drop (P3.2), approve and reopen (D6). Move up
 * and Move down sit on Up next cards and on open plans, Approve on a blocked
 * lane row too. Where the operator is lives in the URL,
 * `?plan=<rootId>&node=<nodeId>` (D8): no plan is the overview, so a reload,
 * back and a link land on the same view and rail. The overview and the board
 * are read again on every plan write and run change (D9). The page takes the
 * skill designer's shell: the list as its outline, the overview or board as
 * its canvas and the rail as its inspector, each a pane on one inset surface.
 * Below 900px the list is a disclosure and the rail a dialog.
 */
import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Badge,
  Button,
  CollapsibleSide,
  Column,
  Dialog,
  Heading,
  PageContainer,
  Row,
  Text,
  useMediaQuery,
} from '@aflow/design-system';
import type {
  PlanBoardColumn,
  PlanBoardOutput,
  PlanNodeListTruncation,
  PlanNodeUpdateOutput,
  PlanOverviewOutput,
} from '@aflow/schemas';
import { useSpaceFromRoute } from '../components/providers.js';
import { useApiMutation, useApiQuery } from '../hooks/useApiQuery.js';
import { spacePlanKey, usePlanLiveRefresh } from '../hooks/use-plan-live-refresh.js';
import { PlanBoard, type PlanNodePlaceRequest } from '../components/plan/PlanBoard.js';
import { PLAN_STATE_BADGE, PlanList, PlanRootCloseControl } from '../components/plan/PlanList.js';
import type {
  PlanNodeOpenRequest,
  PlanNodeReviseRequest,
} from '../components/plan/PlanNodeOpenControl.js';
import { PlanOverview } from '../components/plan/PlanOverview.js';
import { PlanRail, PlanRailFromDetail } from '../components/plan/PlanRail.js';
import { HeadingDot, ProgressMeter } from '../components/plan/PlanParts.js';
import type {
  PlanNodeCloseAnswer,
  PlanNodeCloseRequest,
} from '../components/plan/PlanNodeCloseControl.js';
import {
  doneCardsSince,
  localDay,
  phaseLabel,
  planCards,
  planClosedAncestor,
  planDoneGroups,
  planHeader,
  planLaneOf,
  planLaneRailNode,
  planPhases,
  planViewQuery,
  PLAN_BOARD_COLUMNS,
  readerTimeZone,
  showsPhaseFilter,
  startOfDay,
  type PlanCard,
  type PlanDoneGroup,
} from '../lib/plan-board.js';

const TRUNCATION_LINE: Record<'limit' | 'depth' | 'nodes', (value: number) => string> = {
  limit: (value) => `First ${String(value)} steps`,
  depth: (value) => `Steps deeper than ${String(value)} levels not shown`,
  nodes: (value) => `First ${String(value)} steps`,
};

/** Why a finished plan's header offers no Close plan: its board was read short. */
const CLOSE_WITHHELD_LINE: Record<'limit' | 'depth' | 'nodes', (value: number) => string> = {
  limit: (value) => `Counted short: the first ${String(value)} steps, so no Close plan`,
  depth: (value) =>
    `Counted short: steps deeper than ${String(value)} levels left out, so no Close plan`,
  nodes: (value) => `Counted short: the first ${String(value)} steps, so no Close plan`,
};

function TruncationLine({ truncated }: { truncated: PlanNodeListTruncation | undefined }) {
  if (truncated === undefined) return null;
  return (
    <Text size="xs" variant="muted" data-plan-truncated>
      {TRUNCATION_LINE[truncated.bound](truncated.value)}
    </Text>
  );
}

const COLUMN_COLOR = new Map<PlanBoardColumn, string>(
  PLAN_BOARD_COLUMNS.map((column) => [column.id, column.color]),
);

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <Row gap="xs" align="center" role="group" aria-label={label} data-plan-filter={label}>
      <Text size="xs" variant="muted">
        {label}
      </Text>
      {options.map((option) => (
        <Button
          key={option.id}
          size="sm"
          variant={option.id === value ? 'secondary' : 'ghost'}
          aria-pressed={option.id === value}
          onClick={() => {
            onChange(option.id);
          }}
        >
          {option.label}
        </Button>
      ))}
    </Row>
  );
}

const ALL_PHASES = '';

/** What the board shows of one plan, kept per plan: choosing another starts it afresh. */
interface BoardView {
  rootId: string | undefined;
  phaseId: string;
  /** The Done folds open; null until the operator toggles one: the first fold alone. */
  expanded: ReadonlySet<string> | null;
}

export function SpacePlanPage(): React.ReactNode {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const spaceSlug = routeSpace?.slugFromRoute ?? '';
  const narrow = useMediaQuery('(max-width: 899px)');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const planParam = searchParams.get('plan') ?? undefined;
  const nodeParam = searchParams.get('node') ?? undefined;

  const rowsQuery = useApiQuery<PlanOverviewOutput>({
    key: ['space', spaceId, 'plan', 'rows'],
    path: `/spaces/${spaceId}/plan`,
    enabled: spaceId.length > 0,
  });
  const rows = rowsQuery.data;
  // The plan the URL names, read at once; once the rows answer, a root the
  // space does not hold gives way to the overview, as no plan does.
  const rootId =
    planParam !== undefined &&
    (rows === undefined || rows.roots.some((r) => r.nodeId === planParam))
      ? planParam
      : undefined;

  const [view, setView] = useState<BoardView>({
    rootId,
    phaseId: ALL_PHASES,
    expanded: null,
  });
  const current: BoardView =
    view.rootId === rootId ? view : { rootId, phaseId: ALL_PHASES, expanded: null };
  // The Step pane's fold, for the step the URL names: any change of step
  // unfolds it, while the pane stays mounted and keeps the width dragged.
  const [stepFold, setStepFold] = useState({ nodeId: nodeParam, folded: false });
  if (stepFold.nodeId !== nodeParam) setStepFold({ nodeId: nodeParam, folded: false });
  const stepFolded = stepFold.nodeId === nodeParam && stepFold.folded;
  /** The close form open in the rail, for the step it was opened on. */
  const [choosing, setChoosing] = useState<{
    nodeId: string;
    choosing: 'done' | 'dropped' | null;
  } | null>(null);

  const today = localDay(new Date());
  const tz = readerTimeZone();
  // The last board read of this plan: what the done folds are decided from
  // before the next read, and what stays on screen while an older fold's
  // steps are read.
  const [held, setHeld] = useState<{
    spaceId: string;
    rootId: string;
    since: string;
    data: PlanBoardOutput;
  } | null>(null);
  const last = held?.spaceId === spaceId && held.rootId === rootId ? held.data : undefined;
  const filtered = current.phaseId !== ALL_PHASES;
  const foldsOf = (board: PlanBoardOutput | undefined) =>
    board ? planDoneGroups(board.tally.doneByDay, today) : [];
  const firstFoldOnly = (groups: readonly PlanDoneGroup[]) =>
    new Set(groups[0] ? [groups[0].id] : []);
  const lastGroups = foldsOf(last);
  const since = doneCardsSince(
    lastGroups,
    current.expanded ?? firstFoldOnly(lastGroups),
    today,
    filtered,
  );

  const boardQuery = useApiQuery<PlanBoardOutput>({
    key: ['space', spaceId, 'plan', 'board', rootId ?? '', since, tz],
    path: `/spaces/${spaceId}/plan/roots/${rootId ?? ''}?closedSince=${encodeURIComponent(startOfDay(since))}&tz=${encodeURIComponent(tz)}`,
    enabled: spaceId.length > 0 && rootId !== undefined,
  });
  usePlanLiveRefresh(spaceId.length > 0 ? spaceId : null);
  const data = boardQuery.data;
  useEffect(() => {
    if (data !== undefined && rootId !== undefined) setHeld({ spaceId, rootId, since, data });
  }, [data, spaceId, rootId, since]);
  const board = data ?? last;
  const boardSince =
    data !== undefined
      ? since
      : held?.spaceId === spaceId && held.rootId === rootId
        ? held.since
        : undefined;
  const openFolds = current.expanded ?? firstFoldOnly(foldsOf(board));

  const navigate = (to: { plan?: string | undefined; node?: string | undefined }) => {
    const query = planViewQuery(searchParams.toString(), to);
    router.push(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const closeNode = useApiMutation<PlanNodeCloseRequest, PlanNodeUpdateOutput>({
    path: ({ nodeId }) => `/spaces/${spaceId}/plan/nodes/${nodeId}`,
    method: 'PATCH',
    serialize: ({ nodeId: _nodeId, ...body }) => JSON.stringify(body),
    invalidate: [spacePlanKey(spaceId)],
    // The rail's own form says why; a toast would say it twice.
    onError: () => undefined,
  });

  // Approve, Reopen and Move (Plan 332 D6). Each re-reads the plan on
  // success itself rather than waiting for the space's entity event.
  const openNode = useApiMutation<PlanNodeOpenRequest, PlanNodeUpdateOutput>({
    path: ({ nodeId }) => `/spaces/${spaceId}/plan/nodes/${nodeId}/open`,
    method: 'PATCH',
    serialize: ({ nodeId: _nodeId, ...body }) => JSON.stringify(body),
    invalidate: [spacePlanKey(spaceId)],
    onError: () => undefined,
  });
  // Revise (Plan 337 P4): the step stays blocked, the operator's note above its note.
  const reviseNode = useApiMutation<PlanNodeReviseRequest, PlanNodeUpdateOutput>({
    path: ({ nodeId }) => `/spaces/${spaceId}/plan/nodes/${nodeId}/revise`,
    method: 'PATCH',
    serialize: ({ nodeId: _nodeId, ...body }) => JSON.stringify(body),
    invalidate: [spacePlanKey(spaceId)],
    onError: () => undefined,
  });
  const placeNode = useApiMutation<PlanNodePlaceRequest, PlanNodeUpdateOutput>({
    path: ({ nodeId }) => `/spaces/${spaceId}/plan/nodes/${nodeId}/place`,
    method: 'PATCH',
    serialize: ({ nodeId: _nodeId, ...body }) => JSON.stringify(body),
    invalidate: [spacePlanKey(spaceId)],
    onError: () => undefined,
  });

  const answered = async (write: Promise<unknown>): Promise<PlanNodeCloseAnswer> => {
    try {
      await write;
      return { ok: true };
    } catch (err) {
      // A refusal on the revision — or a sibling that moved — means what is
      // on screen is stale: read it again so the operator chooses against
      // the plan as it now stands.
      if ((err as { status?: unknown }).status === 409) {
        void rowsQuery.refetch();
        if (rootId !== undefined) void boardQuery.refetch();
      }
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
  const onClose = (request: PlanNodeCloseRequest) => answered(closeNode.mutateAsync(request));
  const onOpen = (request: PlanNodeOpenRequest) => answered(openNode.mutateAsync(request));
  const onRevise = (request: PlanNodeReviseRequest) => answered(reviseNode.mutateAsync(request));
  const onPlace = (request: PlanNodePlaceRequest) => answered(placeNode.mutateAsync(request));

  const header = <Heading level={2}>Plan</Heading>;
  const page = (body: React.ReactNode) => (
    <PageContainer>
      <Column gap="lg">
        {header}
        {body}
      </Column>
    </PageContainer>
  );

  if (rows === undefined && (rowsQuery.isLoading || spaceId.length === 0)) {
    return page(<Text>Loading…</Text>);
  }
  if (rows === undefined) {
    return page(
      <Text tone="danger">{`The plan could not be read: ${rowsQuery.error?.message ?? 'no answer'}`}</Text>,
    );
  }
  if (rows.roots.length === 0) {
    return page(<Text variant="muted">No plan yet</Text>);
  }

  const list = (
    <PlanList
      rows={rows.roots}
      selectedId={rootId}
      onSelect={(chosen) => {
        setChoosing(null);
        navigate({ plan: chosen, node: undefined });
      }}
      onOverview={() => {
        setChoosing(null);
        navigate({ plan: undefined, node: undefined });
      }}
      onPlace={onPlace}
      onClose={onClose}
      spaceId={spaceId}
      narrow={narrow}
    />
  );

  /** The rail for the shell's right pane, where the view on screen opens one. */
  let inspector = null as React.ReactNode;
  /** The main view, its rail in the shell's right pane, or below 900px over it as a dialog. */
  const withRail = (main: React.ReactNode, rail: React.ReactNode, dismiss: () => void) => {
    if (!narrow) {
      inspector = rail;
      return main;
    }
    return (
      <>
        {main}
        <Dialog open={rail !== null} onClose={dismiss}>
          {rail}
        </Dialog>
      </>
    );
  };

  const overview = () => {
    const shown = planLaneOf(rows.lanes, nodeParam);
    const formOpen = choosing !== null && choosing.nodeId === nodeParam ? choosing.choosing : null;
    const openRow = (nodeId: string, form: 'done' | null) => {
      setChoosing({ nodeId, choosing: form });
      navigate({ plan: undefined, node: nodeId });
    };
    const dismiss = () => {
      setChoosing(null);
      navigate({ plan: undefined, node: undefined });
    };
    const railControls = {
      spaceId,
      spaceSlug,
      onClose,
      onOpen,
      onRevise,
      choosing: formOpen,
      onChoose: (form: 'done' | 'dropped' | null) => {
        if (nodeParam !== undefined) setChoosing({ nodeId: nodeParam, choosing: form });
      },
      onDismiss: dismiss,
    };
    const rail =
      nodeParam === undefined ? null : shown !== undefined ? (
        <PlanRail
          key={shown.item.nodeId}
          node={planLaneRailNode(shown.item)}
          column={shown.lane}
          reason={shown.item.reason}
          next={shown.lane === 'up_next'}
          phase={shown.item.phaseTitle !== undefined ? { title: shown.item.phaseTitle } : undefined}
          closedAncestor={shown.item.closedAncestor}
          {...railControls}
        />
      ) : (
        // A step no lane holds — a closed one, or one a link names — read on its own.
        <PlanRailFromDetail key={nodeParam} nodeId={nodeParam} {...railControls} />
      );
    return withRail(
      <PlanOverview
        lanes={rows.lanes}
        selectedId={nodeParam}
        now={new Date()}
        spaceSlug={spaceSlug}
        onSelect={(item) => {
          openRow(item.nodeId, null);
        }}
        onDecide={(item) => {
          openRow(item.nodeId, 'done');
        }}
        onOpen={onOpen}
      />,
      rail,
      dismiss,
    );
  };

  const content = (() => {
    if (rootId === undefined) return overview();
    if (board === undefined) {
      return boardQuery.error ? (
        <Text tone="danger">{`This plan could not be read: ${boardQuery.error.message}`}</Text>
      ) : (
        <Text>Loading…</Text>
      );
    }
    const root = board.root;
    const tally = board.tally;
    const cards = planCards(root);
    const selectedCard: PlanCard | undefined = cards.find((c) => c.node.nodeId === nodeParam);
    const formOpen =
      choosing !== null && choosing.nodeId === selectedCard?.node.nodeId ? choosing.choosing : null;
    const phases = planPhases(root);
    const phaseShown = showsPhaseFilter(phases);
    const phaseFilter =
      phaseShown && phases.some((p) => p.nodeId === current.phaseId) ? current.phaseId : ALL_PHASES;
    const planLine = planHeader(tally);

    const toggleGroup = (groupId: string) => {
      const next = new Set(openFolds);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      setView({ ...current, expanded: next });
    };
    const openCard = (card: PlanCard, form: 'done' | null) => {
      setChoosing({ nodeId: card.node.nodeId, choosing: form });
      navigate({ plan: root.nodeId, node: card.node.nodeId });
    };
    const dismiss = () => {
      setChoosing(null);
      navigate({ plan: root.nodeId, node: undefined });
    };

    const rail =
      selectedCard !== undefined ? (
        <PlanRail
          key={selectedCard.node.nodeId}
          node={selectedCard.node}
          column={selectedCard.column}
          reason={selectedCard.reason}
          next={selectedCard.node.nodeId === tally.nextNodeId}
          phase={selectedCard.phase}
          spaceId={spaceId}
          spaceSlug={spaceSlug}
          onClose={onClose}
          closedAncestor={
            selectedCard.reason === 'stranded'
              ? planClosedAncestor(root, selectedCard.node.nodeId)
              : undefined
          }
          onOpen={onOpen}
          onRevise={onRevise}
          choosing={formOpen}
          onChoose={(form) => {
            setChoosing({ nodeId: selectedCard.node.nodeId, choosing: form });
          }}
          onDismiss={dismiss}
        />
      ) : null;

    return (
      <Column gap="md">
        <Row gap="md" align="start" justify="between" wrap>
          <Column gap="xs">
            <Text weight="semibold" size="lg">
              {root.title}
            </Text>
            <Row gap="sm" align="center" wrap data-plan-tally={root.nodeId}>
              <Badge variant={PLAN_STATE_BADGE[tally.state]}>{planLine.state}</Badge>
              <Row gap="xs" align="center">
                <ProgressMeter done={tally.done + tally.dropped} total={tally.steps} />
                <Text size="sm" variant="muted" data-plan-progress-line>
                  {planLine.progress}
                </Text>
              </Row>
              {planLine.counts.map(({ column, label }) => (
                <Row key={column} gap="xs" align="center" data-plan-tally-count={column}>
                  <HeadingDot color={COLUMN_COLOR.get(column) ?? 'var(--color-border-emphasis)'} />
                  <Text size="sm" variant="muted">
                    {label}
                  </Text>
                </Row>
              ))}
            </Row>
            {tally.state === 'finished' &&
              (board.truncated === undefined ? (
                <PlanRootCloseControl
                  key={root.nodeId}
                  rootId={root.nodeId}
                  spaceId={spaceId}
                  onClose={onClose}
                />
              ) : (
                // Steps the board's read did not reach may be open, as on a row counted short.
                <Text size="xs" variant="muted" data-plan-close-withheld>
                  {CLOSE_WITHHELD_LINE[board.truncated.bound](board.truncated.value)}
                </Text>
              ))}
          </Column>
          {phaseShown && (
            <Segmented
              label="Phase"
              options={[
                { id: ALL_PHASES, label: 'All' },
                ...phases.map((p) => ({ id: p.nodeId, label: phaseLabel(p.title) })),
              ]}
              value={phaseFilter}
              onChange={(phaseId) => {
                setView({ ...current, phaseId });
              }}
            />
          )}
        </Row>
        {boardQuery.error && (
          <Text
            size="sm"
            tone="danger"
          >{`The plan could not be read: ${boardQuery.error.message}`}</Text>
        )}
        {withRail(
          <PlanBoard
            root={root}
            tally={tally}
            filters={phaseFilter !== ALL_PHASES ? { phaseId: phaseFilter } : {}}
            doneReadSince={boardSince}
            today={today}
            expanded={openFolds}
            onToggleGroup={toggleGroup}
            selectedId={selectedCard?.node.nodeId}
            onSelect={(card) => {
              openCard(card, null);
            }}
            onDecide={(card) => {
              openCard(card, 'done');
            }}
            onPlace={onPlace}
            narrow={narrow}
          />,
          rail,
          dismiss,
        )}
        <TruncationLine truncated={board.truncated} />
      </Column>
    );
  })();

  const listNotes = (
    <>
      {rowsQuery.error && (
        <Text
          size="sm"
          tone="danger"
        >{`The plans could not be read: ${rowsQuery.error.message}`}</Text>
      )}
      {rows.truncated !== undefined && (
        <Text size="xs" variant="muted" data-plan-list-truncated>
          {`First ${String(rows.truncated.value)} plans`}
        </Text>
      )}
    </>
  );

  if (narrow) {
    return (
      <PageContainer maxWidth="none">
        <Column gap="md">
          {header}
          {list}
          {content}
          {listNotes}
        </Column>
      </PageContainer>
    );
  }

  // The skill designer's shell: the plan list as its outline, the overview or
  // the board as its canvas, the step rail as its inspector, each a pane of
  // its own on one inset surface.
  const needsYou = rows.roots.reduce((sum, row) => sum + (row.counts?.needsYou ?? 0), 0);
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}
    >
      <Row gap="sm" align="center" wrap style={{ padding: 'var(--space-sm) var(--space-md) 0' }}>
        {header}
        {listNotes}
      </Row>
      <div
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          gap: 'var(--space-sm)',
          backgroundColor: 'var(--surface-overlay-alpha)',
          padding: 'var(--space-2-5)',
          borderRadius: 'var(--radius-lg)',
          margin: 'var(--space-2)',
        }}
      >
        <CollapsibleSide
          side="left"
          defaultWidth={280}
          minWidth={220}
          maxWidth={400}
          icon="list"
          label="Plans"
          badge={needsYou}
        >
          <Pane>{list}</Pane>
        </CollapsibleSide>
        <Pane style={{ flex: 1, minWidth: 0 }}>
          <div style={{ height: '100%', overflow: 'auto', padding: 'var(--space-lg)' }}>
            {content}
          </div>
        </Pane>
        {inspector !== null && (
          <CollapsibleSide
            side="right"
            defaultWidth={372}
            minWidth={280}
            maxWidth={560}
            icon="sliders"
            label="Step"
            collapsed={stepFolded}
            onCollapsedChange={(folded) => {
              setStepFold({ nodeId: nodeParam, folded });
            }}
          >
            <Pane>
              <aside
                aria-label="Step"
                style={{ height: '100%', overflow: 'auto', padding: 'var(--space-lg)' }}
              >
                {inspector}
              </aside>
            </Pane>
          </CollapsibleSide>
        )}
      </div>
    </div>
  );
}

/** One pane of the shell, the surface the skill designer sets each of its panes on. */
function Pane({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--surface-overlay-alpha)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-xs)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
