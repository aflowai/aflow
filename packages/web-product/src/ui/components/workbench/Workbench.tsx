'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Column, Text } from '@aflow/design-system';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useActionCenter } from '../../hooks/use-action-center.js';
import { useSpaceWorkflowRuns } from '../../hooks/use-space-workflow-runs.js';
import { planPendingCount } from '../../lib/plan-pending-count.js';
import { browserStorage } from '../../lib/workbench-dock-memory.js';
import {
  placeWorkbenchSections,
  readHeldSections,
  rememberHeldSection,
} from '../../lib/workbench-held-sections.js';
import { WorkbenchNeedsAttention, waitingOnLabel } from './WorkbenchNeedsAttention.js';
import { FoldedSchedulesNotice, WorkbenchSchedules } from './WorkbenchSchedules.js';
import { useSpacePeople } from '../../hooks/use-space-people.js';
import {
  COACH_REVIEW,
  WorkbenchCoachFold,
  WorkbenchProposalSources,
  coachReviewProposals,
  useCoachReviewInProgress,
} from './WorkbenchCoach.js';
import {
  FoldedPlanPendingCount,
  WORKBENCH_PLAN,
  WorkbenchPlan,
  planBoardLink,
} from './WorkbenchPlan.js';
import {
  WorkbenchFoldsContext,
  WorkbenchHeldContext,
  WORKBENCH_MORE,
  WorkbenchLazySection,
  WorkbenchMoreFold,
  useWorkbenchFoldsOrOwn,
} from './WorkbenchSection.js';
import {
  LiveRunBadges,
  WorkbenchSkills,
  skillRuns,
  skillsFromWorkflows,
  type WorkbenchWorkflow,
} from './WorkbenchSkills.js';
import { WorkbenchApplets } from './WorkbenchApplets.js';
import { WorkbenchAgents } from './WorkbenchAgents.js';
import { FoldedIntegrationsSetupCount, WorkbenchIntegrations } from './WorkbenchIntegrations.js';
import { WorkbenchRecentConversations } from './WorkbenchRecentConversations.js';

/**
 * The Space Workbench (Plan 228): a space-wide board of what's happening in the
 * agent's space and what needs the operator. One component; the chat mounts it
 * as the inspector's primary tab.
 *
 * The board answers three questions, and they are not equally patient, so the
 * pane is split rather than stacked:
 *
 * 1. **What needs me** — blocking requests and Coach proposals.
 * 2. **What is in this space** — the skills, applets, and integrations the agent
 *    can work with, and what is live in each.
 * 3. **Where was I** — recent conversations.
 *
 * (1) and (2) grow without limit: a space can hold twenty skills each with runs.
 * (3) does not grow but is needed constantly. Stacked in one scroll, (2) pushes
 * (3) off the bottom and the operator loses their history the moment the space
 * gets interesting. So the inventory scrolls and **recent conversations is
 * pinned to the floor of the pane**, capped and scrolling inside itself.
 *
 * The chat opens this board by default on a new chat, so what it mounts on
 * open is a cost on every landing. Only (1) and (3) mount then. Each section
 * of (2), and the Coach's, is folded and mounts only when the operator expands
 * it (Plan 338 D3, where the reads are counted). A folded header still shows
 * what would have put the section in front of the operator, from what the
 * page holds and with no read or timer of its own. Skills shows its live runs
 * from the run feed (1) holds. Schedules counts the Action Center's notices
 * that an agent set one up. Integrations counts the Action Center's connection
 * requests alone, because nothing refreshes the readiness reads while it is
 * folded. The Coach shows its proposals and a review the entity-events stream
 * has seen start. Plan counts the plan steps pending on the operator from the
 * Action Center, as the sidebar does, and links to the board. Skills counts
 * the skills. Applets and Agents ask nothing of the operator, so their
 * headers carry nothing. The workflow list is read on open, because recent
 * conversations names runs by it.
 *
 * A folded section that has never held content in the space sits behind one
 * More fold at the bottom of the inventory (`workbench-held-sections.ts`), so
 * an empty section does not cost the height of a full one.
 */
export function Workbench({
  spaceId,
  spaceSlug,
  onSeed,
  onRevealChat,
  currentSessionId,
}: {
  spaceId: string;
  spaceSlug: string;
  /** The conversation the Workbench sits beside, when one is open. */
  currentSessionId?: string | null | undefined;
  /** Seed the composer + start a new chat (Plan 228 §5.3). */
  onSeed?: (seed: string) => void;
  /** Phone: leave Workbench mode after opening a session into the chat. */
  onRevealChat?: () => void;
}) {
  const seed = onSeed ?? (() => undefined);
  const runsState = useSpaceWorkflowRuns(spaceId);
  const actionCenter = useActionCenter(spaceId);

  // Every workflow's name, the platform's own included: a conversation's
  // commission or publication is a run of a system workflow, which the skill
  // list leaves out. The board reads the list on open, because recent
  // conversations and the folded Skills header both need it.
  const workflowList = useWorkflowList(spaceId);
  const workflowNames = useMemo(
    () => new Map((workflowList.data?.workflows ?? []).map((w) => [w.slug, w.name] as const)),
    [workflowList.data],
  );
  // The skills Skills lists once expanded, and their live runs from the feed
  // the board already holds. The folded header badges these same runs, so it
  // and the list read one rule.
  const skills = useMemo(
    () => skillsFromWorkflows(workflowList.data?.workflows ?? []),
    [workflowList.data],
  );
  const liveSkillRuns = useMemo(() => skillRuns(runsState.runs, skills), [runsState.runs, skills]);

  // What each paused run is waiting on, said as a person. Derived from the
  // open items rather than the run row, so the label and the card that
  // resolves it can never disagree about who is being asked.
  const personFor = useSpacePeople(spaceId);
  const waitingOnByRun = useMemo(() => {
    const byRun = new Map<string, string>();
    for (const item of actionCenter.items) {
      const o = item.origin;
      const runId =
        o.type === 'workflow_task' || o.type === 'step' || o.type === 'gate' ? o.runId : null;
      if (!runId || byRun.has(runId)) continue;
      if (!item.assignee && !item.resolverPolicy?.candidateResolvers?.length) continue;
      byRun.set(runId, waitingOnLabel(item, personFor));
    }
    return byRun;
  }, [actionCenter.items, personFor]);

  const planPending = useMemo(
    () => planPendingCount(actionCenter.items, { whole: actionCenter.listIsWhole }),
    [actionCenter.items, actionCenter.listIsWhole],
  );
  const coachReview = useCoachReviewInProgress(spaceId);
  const scheduleNotices = actionCenter.lanes.notices.some((item) => item.kind === 'trigger_armed');

  // Every folded section, in the pane's order, with whether what the board
  // already holds shows it has content now. The rest of what decides its place
  // is the record of what it has held (`useHeldSections`).
  const sections: WorkbenchFoldedSection[] = [
    {
      // Under what is pending: a plan step that waits on the operator is
      // pending too, and its fold is where the plan's other live steps are.
      title: WORKBENCH_PLAN,
      holdsContent: planPending.count > 0,
      node: (
        <WorkbenchLazySection
          title={WORKBENCH_PLAN}
          icon="flag"
          meta={<FoldedPlanPendingCount pending={planPending} />}
          link={planBoardLink(spaceSlug)}
        >
          <WorkbenchPlan spaceId={spaceId} spaceSlug={spaceSlug} pending={planPending} />
        </WorkbenchLazySection>
      ),
    },
    {
      title: 'Schedules',
      holdsContent: scheduleNotices,
      node: (
        <WorkbenchLazySection
          title="Schedules"
          icon="clock"
          meta={<FoldedSchedulesNotice state={actionCenter} />}
        >
          <WorkbenchSchedules
            state={actionCenter}
            spaceId={spaceId}
            spaceSlug={spaceSlug}
            currentSessionId={currentSessionId}
          />
        </WorkbenchLazySection>
      ),
    },
    {
      title: 'Skills',
      holdsContent: skills.length > 0,
      node: (
        <WorkbenchLazySection
          title="Skills"
          icon="skill"
          meta={
            <>
              <FoldedSkillsCount count={skills.length} />
              <LiveRunBadges runs={liveSkillRuns} />
            </>
          }
        >
          <WorkbenchSkills
            spaceId={spaceId}
            spaceSlug={spaceSlug}
            skills={skills}
            loading={workflowList.isLoading}
            activeRuns={liveSkillRuns}
            waitingOnByRun={waitingOnByRun}
            onRun={(skill) => {
              seed(`Run the "${skill.name}" skill. `);
            }}
            {...(onRevealChat ? { onRevealChat } : {})}
          />
        </WorkbenchLazySection>
      ),
    },
    {
      title: 'Applets',
      holdsContent: false,
      node: (
        <WorkbenchLazySection title="Applets" icon="squares-four">
          <WorkbenchApplets
            spaceId={spaceId}
            spaceSlug={spaceSlug}
            {...(onRevealChat ? { onRevealChat } : {})}
          />
        </WorkbenchLazySection>
      ),
    },
    {
      // Below the capabilities and above the substrate: an agent is someone
      // who works here rather than something the space can do, so it does
      // not belong among Skills — but it is still inventory, not plumbing.
      title: 'Agents',
      holdsContent: false,
      node: (
        <WorkbenchLazySection title="Agents" icon="robot">
          <WorkbenchAgents
            spaceId={spaceId}
            spaceSlug={spaceSlug}
            {...(onRevealChat ? { onRevealChat } : {})}
          />
        </WorkbenchLazySection>
      ),
    },
    {
      // Last of the inventory: an integration is the substrate the other
      // two run on, not work in its own right, so it sits below them.
      title: 'Integrations',
      holdsContent: actionCenter.lanes.connections.length > 0,
      node: (
        <WorkbenchLazySection
          title="Integrations"
          icon="plugs-connected"
          meta={
            <FoldedIntegrationsSetupCount connectionRequests={actionCenter.lanes.connections} />
          }
        >
          <WorkbenchIntegrations
            spaceId={spaceId}
            spaceSlug={spaceSlug}
            connectionRequests={actionCenter.lanes.connections}
          />
        </WorkbenchLazySection>
      ),
    },
    {
      title: COACH_REVIEW,
      holdsContent: coachReviewProposals(actionCenter).length > 0 || coachReview !== null,
      node: (
        <WorkbenchCoachFold
          state={actionCenter}
          spaceId={spaceId}
          spaceSlug={spaceSlug}
          review={coachReview}
        />
      ),
    },
  ];
  const folds = useWorkbenchFoldsOrOwn();
  const { placement, recordHeld } = useHeldSections(spaceId, sections, folds);
  const { inPlace, more } = placement;

  return (
    <Column gap="none" style={{ flex: 1, minHeight: 0 }}>
      {/* `flex: 1 1 auto` — basis `auto`, not 0, so the inventory's real content
          height takes part in the shrink below. With a basis of 0 it never
          competes and the floor would reserve its full share on an empty board. */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', scrollbarWidth: 'thin' }}>
        <Column gap="2xl" style={{ padding: 'var(--space-3) var(--space-2)' }}>
          <WorkbenchNeedsAttention state={actionCenter} spaceId={spaceId} />
          <WorkbenchProposalSources state={actionCenter} spaceSlug={spaceSlug} />
          {/* Folded below this line (Plan 338 D3): each section mounts, and
              reads, only when the operator expands it. A section that has
              never held content sits behind More instead. */}
          <WorkbenchFoldsContext.Provider value={folds}>
            <WorkbenchHeldContext.Provider value={recordHeld}>
              {inPlace.map((section) => (
                <Fragment key={section.title}>{section.node}</Fragment>
              ))}
              {more.length > 0 && (
                <WorkbenchMoreFold titles={more.map((section) => section.title)}>
                  {more.map((section) => (
                    <Fragment key={section.title}>{section.node}</Fragment>
                  ))}
                </WorkbenchMoreFold>
              )}
            </WorkbenchHeldContext.Provider>
          </WorkbenchFoldsContext.Provider>
        </Column>
      </div>
      {/* The floor of the pane. It sizes itself (see the component) rather than
          sitting in a wrapper here, because a wrapper would hold its floor open
          on a space that has no conversations to show yet. */}
      <WorkbenchRecentConversations
        spaceId={spaceId}
        spaceSlug={spaceSlug}
        activeRuns={runsState.runs}
        workflowNames={workflowNames}
        {...(onRevealChat ? { onRevealChat } : {})}
      />
    </Column>
  );
}

interface WorkbenchFoldedSection {
  title: string;
  /** What the board already holds shows the section has content now. */
  holdsContent: boolean;
  node: ReactNode;
}

/**
 * Where each folded section stands, and where a section that has held content
 * is recorded. The record is read from storage once per space. A section
 * whose header signal shows content is recorded and keeps its place after the
 * signal goes. A section the operator has open under More stays there while
 * it is open, whatever its signal or its content says. Once they close it, it
 * follows its header signal again, so a count or a badge that turns on brings
 * it to its place. What its content records reaches storage only, so a
 * section without a header signal moves to its place on the next mount.
 */
function useHeldSections(
  spaceId: string,
  sections: readonly WorkbenchFoldedSection[],
  folds: { isExpanded: (title: string) => boolean },
): {
  placement: { inPlace: WorkbenchFoldedSection[]; more: WorkbenchFoldedSection[] };
  recordHeld: (title: string) => void;
} {
  const [state, setState] = useState<HeldState>(() => freshHeldState(spaceId));
  const known = state.spaceId === spaceId ? state : freshHeldState(spaceId);
  // A section is open under More only while More is open too: behind a
  // closed More fold the operator reads its title alone.
  const moreOpen = folds.isExpanded(WORKBENCH_MORE);
  const { keptUnderMore, ...placement } = placeWorkbenchSections(
    sections,
    known.held,
    known.keptUnderMore,
    (title) => moreOpen && folds.isExpanded(title),
  );
  const current = keptUnderMore === known.keptUnderMore ? known : { ...known, keptUnderMore };
  if (current !== state) setState(current);

  const signalled = sections
    .filter((section) => section.holdsContent && !current.held.has(section.title))
    .map((section) => section.title)
    .join('\n');
  useEffect(() => {
    if (signalled === '') return;
    const titles = signalled.split('\n');
    for (const title of titles) rememberHeldSection(browserStorage(), spaceId, title);
    setState((prev) =>
      prev.spaceId === spaceId ? { ...prev, held: new Set([...prev.held, ...titles]) } : prev,
    );
  }, [signalled, spaceId]);

  const recordHeld = useCallback(
    (title: string) => {
      rememberHeldSection(browserStorage(), spaceId, title);
    },
    [spaceId],
  );
  return { placement, recordHeld };
}

interface HeldState {
  spaceId: string;
  held: ReadonlySet<string>;
  keptUnderMore: ReadonlySet<string>;
}

function freshHeldState(spaceId: string): HeldState {
  return {
    spaceId,
    held: new Set(readHeldSections(browserStorage(), spaceId)),
    keptUnderMore: new Set(),
  };
}

/**
 * The folded Skills header's count of the space's skills, from the workflow
 * list the board reads on open. It counts what the expanded list shows, so
 * the two never disagree.
 */
export function FoldedSkillsCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Text size="xs" variant="muted">
      {`${String(count)} ${count === 1 ? 'skill' : 'skills'}`}
    </Text>
  );
}

/** The space's workflows, archived included, under the key other pages read it by. */
function useWorkflowList(spaceId: string) {
  return useApiQuery<{ workflows: WorkbenchWorkflow[] }>({
    key: ['space', spaceId, 'workflows', 'all'],
    path: `/spaces/${spaceId}/workflows?archived=true`,
    spaceId,
    staleTime: 30_000,
    enabled: !!spaceId,
  });
}
