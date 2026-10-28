'use client';

/**
 * The space's plan (Plan 322 P3.3): a board. A tab per plan, the plan's
 * header — steps closed and the non-zero count of each column — five columns
 * saying what the loop is doing with each step (Plan 332 D4), a card per step
 * carrying labels only, and a side rail that reads a step on demand and holds
 * the operator's own controls — mark done, decide, drop (P3.2), approve and
 * reopen (Plan 332 D6) — with Move up and Move down on Up next cards. The tree it
 * reads carries counts rather than links, and done steps only for the Done
 * folds open. It is read again on every plan write and run change (D9).
 */
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Column,
  Dialog,
  Heading,
  PageContainer,
  Row,
  Tab,
  TabList,
  Tabs,
  Text,
  useMediaQuery,
  type BadgeVariant,
} from '@aflow/design-system';
import type { PlanBoardColumn, PlanNodeUpdateOutput, PlanTreeOutput } from '@aflow/schemas';
import { useSpaceFromRoute } from '../components/providers.js';
import { useApiMutation, useApiQuery } from '../hooks/useApiQuery.js';
import { spacePlanKey, usePlanLiveRefresh } from '../hooks/use-plan-live-refresh.js';
import { PlanBoard, type PlanNodePlaceRequest } from '../components/plan/PlanBoard.js';
import type { PlanNodeOpenRequest } from '../components/plan/PlanNodeOpenControl.js';
import { PlanRail, RAIL_WIDTH } from '../components/plan/PlanRail.js';
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
  planPhases,
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

const HEADER_BADGE: Record<PlanBoardColumn, BadgeVariant> = {
  needs_you: 'warning',
  in_flight: 'running',
  up_next: 'accent',
  done: 'success',
  dropped: 'danger',
};

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

export function SpacePlanPage(): React.ReactNode {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const spaceSlug = routeSpace?.slugFromRoute ?? '';
  const narrow = useMediaQuery('(max-width: 899px)');

  const [chosenRootId, setChosenRootId] = useState<string | undefined>(undefined);
  const [phaseId, setPhaseId] = useState<string>(ALL_PHASES);
  /** The Done folds open; null until the operator toggles one: the first fold alone. */
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [selected, setSelected] = useState<{
    nodeId: string;
    choosing: 'done' | 'dropped' | null;
  } | null>(null);

  const today = localDay(new Date());
  const tz = readerTimeZone();
  // The last board read: what the done folds are decided from before the
  // next read, and what stays on screen while an older fold's steps are read.
  const [held, setHeld] = useState<{
    spaceId: string;
    since: string;
    data: PlanTreeOutput;
  } | null>(null);
  const last = held?.spaceId === spaceId ? held.data : undefined;
  const rootOf = (tree: PlanTreeOutput | undefined) =>
    tree?.roots.find((r) => r.nodeId === chosenRootId) ?? tree?.roots[0];
  const filtered = phaseId !== ALL_PHASES;
  const foldsOf = (tree: PlanTreeOutput | undefined) => {
    const tally = tree?.tallies.find((t) => t.rootId === rootOf(tree)?.nodeId);
    return tally ? planDoneGroups(tally.doneByDay, today) : [];
  };
  const firstFoldOnly = (groups: readonly PlanDoneGroup[]) =>
    new Set(groups[0] ? [groups[0].id] : []);
  const lastGroups = foldsOf(last);
  const since = doneCardsSince(lastGroups, expanded ?? firstFoldOnly(lastGroups), today, filtered);

  const { data, isLoading, error, refetch } = useApiQuery<PlanTreeOutput>({
    key: ['space', spaceId, 'plan', 'board', since, tz],
    path: `/spaces/${spaceId}/plan?closedSince=${encodeURIComponent(startOfDay(since))}&tz=${encodeURIComponent(tz)}`,
    enabled: spaceId.length > 0,
  });
  usePlanLiveRefresh(spaceId.length > 0 ? spaceId : null);
  useEffect(() => {
    if (data !== undefined) setHeld({ spaceId, since, data });
  }, [data, spaceId, since]);
  const board = data ?? last;
  const boardSince =
    data !== undefined ? since : held?.spaceId === spaceId ? held.since : undefined;
  const openFolds = expanded ?? firstFoldOnly(foldsOf(board));

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
      // A refusal on the revision — or a sibling that moved — means the board
      // on screen is stale: read it again so the operator chooses against
      // the plan as it now stands.
      if ((err as { status?: unknown }).status === 409) void refetch();
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
  const onClose = (request: PlanNodeCloseRequest) => answered(closeNode.mutateAsync(request));
  const onOpen = (request: PlanNodeOpenRequest) => answered(openNode.mutateAsync(request));
  const onPlace = (request: PlanNodePlaceRequest) => answered(placeNode.mutateAsync(request));

  const header = <Heading level={2}>Plan</Heading>;

  if (board === undefined && (isLoading || spaceId.length === 0)) {
    return (
      <PageContainer>
        <Column gap="lg">
          {header}
          <Text>Loading…</Text>
        </Column>
      </PageContainer>
    );
  }

  if (board === undefined) {
    return (
      <PageContainer>
        <Column gap="lg">
          {header}
          <Text tone="danger">{`The plan could not be read: ${error?.message ?? 'no answer'}`}</Text>
        </Column>
      </PageContainer>
    );
  }

  const root = rootOf(board);
  const tally = board.tallies.find((t) => t.rootId === root?.nodeId);
  if (root === undefined || tally === undefined) {
    return (
      <PageContainer>
        <Column gap="lg">
          {header}
          <Text variant="muted">No plan yet</Text>
        </Column>
      </PageContainer>
    );
  }

  const cards = planCards(root);
  const selectedCard: PlanCard | undefined = cards.find((c) => c.node.nodeId === selected?.nodeId);
  const phases = planPhases(root);
  const phaseShown = showsPhaseFilter(phases);
  const phaseFilter = phaseShown && phases.some((p) => p.nodeId === phaseId) ? phaseId : ALL_PHASES;
  const planLine = planHeader(tally);

  const chooseRoot = (rootId: string) => {
    setChosenRootId(rootId);
    setPhaseId(ALL_PHASES);
    setExpanded(null);
    setSelected(null);
  };
  const toggleGroup = (groupId: string) => {
    const next = new Set(openFolds);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setExpanded(next);
  };

  const rail =
    selectedCard !== undefined && selected !== null ? (
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
        choosing={selected.choosing}
        onChoose={(choosing) => {
          setSelected({ nodeId: selectedCard.node.nodeId, choosing });
        }}
        onDismiss={() => {
          setSelected(null);
        }}
      />
    ) : null;

  return (
    <PageContainer maxWidth="none">
      <Column gap="md">
        {header}
        <Row gap="md" align="center" justify="between" wrap>
          <Tabs value={root.nodeId} onChange={chooseRoot}>
            <TabList style={{ marginBottom: 0 }}>
              {board.roots.map((r) => (
                <Tab
                  key={r.nodeId}
                  id={r.nodeId}
                  count={board.tallies.find((t) => t.rootId === r.nodeId)?.steps ?? 0}
                >
                  {r.title}
                </Tab>
              ))}
            </TabList>
          </Tabs>
          <Row gap="md" align="center" wrap>
            {phaseShown && (
              <Segmented
                label="Phase"
                options={[
                  { id: ALL_PHASES, label: 'All' },
                  ...phases.map((p) => ({ id: p.nodeId, label: phaseLabel(p.title) })),
                ]}
                value={phaseFilter}
                onChange={setPhaseId}
              />
            )}
          </Row>
        </Row>
        <Column gap="xs">
          <Text weight="semibold">{root.title}</Text>
          <Row gap="xs" align="center" wrap data-plan-tally={root.nodeId}>
            <Text size="sm" variant="muted" data-plan-progress-line>
              {planLine.progress}
            </Text>
            {planLine.counts.map(({ column, label }) => (
              <Badge key={column} variant={HEADER_BADGE[column]}>
                {label}
              </Badge>
            ))}
          </Row>
        </Column>
        {error && (
          <Text size="sm" tone="danger">{`The plan could not be read: ${error.message}`}</Text>
        )}
        <Row gap="md" align="start">
          <div style={{ flex: 1, minWidth: 0 }}>
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
                setSelected({ nodeId: card.node.nodeId, choosing: null });
              }}
              onDecide={(card) => {
                setSelected({ nodeId: card.node.nodeId, choosing: 'done' });
              }}
              onPlace={onPlace}
              narrow={narrow}
            />
          </div>
          {rail !== null && !narrow && (
            <aside
              aria-label="Step"
              style={{
                width: RAIL_WIDTH,
                flexShrink: 0,
                position: 'sticky',
                top: 0,
                maxHeight: '100vh',
                overflowY: 'auto',
                borderLeft: '1px solid var(--color-border-subtle)',
                paddingLeft: 'var(--space-3)',
              }}
            >
              {rail}
            </aside>
          )}
        </Row>
        {narrow && (
          <Dialog
            open={rail !== null}
            onClose={() => {
              setSelected(null);
            }}
          >
            {rail}
          </Dialog>
        )}
        {board.truncated !== undefined && (
          <Text size="xs" variant="muted">
            {TRUNCATION_LINE[board.truncated.bound](board.truncated.value)}
          </Text>
        )}
      </Column>
    </PageContainer>
  );
}
