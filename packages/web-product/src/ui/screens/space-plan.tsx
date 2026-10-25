'use client';

/**
 * The space's plan (Plan 322 P3.3): a board. A tab per plan, five columns in
 * which the column is the status, a card per step carrying labels only, and
 * a side rail that reads a step on demand and holds the operator's own
 * controls — mark done, decide, drop (P3.2). The tree it reads carries counts
 * rather than links, and done steps only for the Done folds open.
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
} from '@aflow/design-system';
import type { PlanNodeUpdateOutput, PlanTreeNode, PlanTreeOutput } from '@aflow/schemas';
import { useSpaceFromRoute } from '../components/providers.js';
import { useApiMutation, useApiQuery } from '../hooks/useApiQuery.js';
import { PlanBoard } from '../components/plan/PlanBoard.js';
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
  planDoneGroups,
  readerTimeZone,
  startOfDay,
  type PlanCard,
  type PlanDoneGroup,
  type PlanDoneWindow,
  type PlanActivityFilter,
} from '../lib/plan-board.js';

const TRUNCATION_LINE: Record<'limit' | 'depth' | 'nodes', (value: number) => string> = {
  limit: (value) => `First ${String(value)} steps`,
  depth: (value) => `Steps deeper than ${String(value)} levels not shown`,
  nodes: (value) => `First ${String(value)} steps`,
};

const ACTIVITY_OPTIONS: ReadonlyArray<{ id: PlanActivityFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'in_flight', label: 'In flight' },
  { id: 'idle', label: 'Idle' },
];

/** What moves a step between the two, and that neither asks anything of the reader. */
const ACTIVITY_LINES: ReadonlyArray<{ label: string; line: string }> = [
  {
    label: 'In flight',
    line: 'a run is working on the step or one under it; it goes idle when that run ends.',
  },
  {
    label: 'Idle',
    line: 'no run is on it now; it goes in flight when the loop starts one. Neither asks anything of you.',
  },
];

const WINDOW_OPTIONS: ReadonlyArray<{ id: PlanDoneWindow; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 days' },
  { id: 'all', label: 'All' },
];

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
  const [activity, setActivity] = useState<PlanActivityFilter>('all');
  const [doneWindow, setDoneWindow] = useState<PlanDoneWindow>('all');
  /** The Done folds open; null until the operator toggles one: the first fold alone. */
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [selected, setSelected] = useState<{
    nodeId: string;
    choosing: 'done' | 'dropped' | null;
  } | null>(null);

  const today = localDay(new Date());
  const tz = readerTimeZone();
  // The last board read: what the done folds are decided from before the
  // next read, and what stays on screen while a wider done window is read.
  const [held, setHeld] = useState<{
    spaceId: string;
    since: string;
    data: PlanTreeOutput;
  } | null>(null);
  const last = held?.spaceId === spaceId ? held.data : undefined;
  const filtered = phaseId !== ALL_PHASES || activity !== 'all';

  const rootOf = (tree: PlanTreeOutput | undefined) =>
    tree?.roots.find((r) => r.nodeId === chosenRootId) ?? tree?.roots[0];
  const foldsOf = (tree: PlanTreeOutput | undefined) => {
    const tally = tree?.tallies.find((t) => t.rootId === rootOf(tree)?.nodeId);
    return tally ? planDoneGroups(tally.doneByDay, today, doneWindow) : [];
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
    invalidate: [['space', spaceId, 'plan']],
    // The rail's own form says why; a toast would say it twice.
    onError: () => undefined,
  });

  const onClose = async (request: PlanNodeCloseRequest): Promise<PlanNodeCloseAnswer> => {
    try {
      await closeNode.mutateAsync(request);
      return { ok: true };
    } catch (err) {
      // A refusal on the revision means the board on screen is stale: read it
      // again so the operator chooses against the node as it now stands.
      if ((err as { status?: unknown }).status === 409) void refetch();
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };

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
  const phases = root.children.filter((child: PlanTreeNode) => child.children.length > 0);
  const phaseFilter = phases.some((p) => p.nodeId === phaseId) ? phaseId : ALL_PHASES;

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
        phase={selectedCard.phase}
        spaceId={spaceId}
        spaceSlug={spaceSlug}
        onClose={onClose}
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
            {phases.length > 0 && (
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
            <Column gap="none" data-plan-activity-help>
              <Segmented
                label="Activity"
                options={ACTIVITY_OPTIONS}
                value={activity}
                onChange={setActivity}
              />
              {ACTIVITY_LINES.map(({ label, line }) => (
                <Text key={label} size="xs" variant="muted">
                  <strong>{label}</strong>
                  {` — ${line}`}
                </Text>
              ))}
            </Column>
            <Segmented
              label="Done"
              options={WINDOW_OPTIONS}
              value={doneWindow}
              onChange={(next) => {
                setDoneWindow(next);
                setExpanded(null);
              }}
            />
          </Row>
        </Row>
        <Column gap="xs">
          <Text weight="semibold">{root.title}</Text>
          <Row gap="xs" align="center" wrap data-plan-tally={root.nodeId}>
            <Badge variant="success">{`${String(tally.done)} done`}</Badge>
            <Badge variant="running">{`${String(tally.active)} active`}</Badge>
            <Badge variant="warning">{`${String(tally.decide)} decide`}</Badge>
            <Badge variant="danger">{`${String(tally.dropped)} dropped`}</Badge>
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
              filters={{
                ...(phaseFilter !== ALL_PHASES ? { phaseId: phaseFilter } : {}),
                activity,
              }}
              doneWindow={doneWindow}
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
