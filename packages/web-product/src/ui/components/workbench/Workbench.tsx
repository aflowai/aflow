'use client';

import { useMemo } from 'react';
import { Column } from '@aflow/design-system';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useActionCenter } from '../../hooks/use-action-center.js';
import { useSpaceWorkflowRuns } from '../../hooks/use-space-workflow-runs.js';
import { WorkbenchNeedsAttention, waitingOnLabel } from './WorkbenchNeedsAttention.js';
import { FoldedSchedulesNotice, WorkbenchSchedules } from './WorkbenchSchedules.js';
import { useSpacePeople } from '../../hooks/use-space-people.js';
import { WorkbenchCoachFold, WorkbenchProposalSources } from './WorkbenchCoach.js';
import { WorkbenchLazySection } from './WorkbenchSection.js';
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
 * requests, joined by the readiness reads once an expand has left them in the
 * cache. The Coach shows its proposals and a review the entity-events stream
 * has seen start. Applets and Agents ask nothing of the operator, so their
 * headers carry nothing. The workflow list is read on open, because recent
 * conversations names runs by it.
 */
export function Workbench({
  spaceId,
  spaceSlug,
  onSeed,
  onRevealChat,
}: {
  spaceId: string;
  spaceSlug: string;
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
              reads, only when the operator expands it. */}
          <WorkbenchLazySection
            title="Schedules"
            icon="clock"
            meta={<FoldedSchedulesNotice state={actionCenter} />}
          >
            <WorkbenchSchedules state={actionCenter} spaceId={spaceId} spaceSlug={spaceSlug} />
          </WorkbenchLazySection>
          <WorkbenchLazySection
            title="Skills"
            icon="skill"
            meta={<LiveRunBadges runs={liveSkillRuns} />}
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
          <WorkbenchLazySection title="Applets" icon="squares-four">
            <WorkbenchApplets
              spaceId={spaceId}
              spaceSlug={spaceSlug}
              {...(onRevealChat ? { onRevealChat } : {})}
            />
          </WorkbenchLazySection>
          {/* Below the capabilities and above the substrate: an agent is someone
              who works here rather than something the space can do, so it does
              not belong among Skills — but it is still inventory, not plumbing. */}
          <WorkbenchLazySection title="Agents" icon="robot">
            <WorkbenchAgents
              spaceId={spaceId}
              spaceSlug={spaceSlug}
              {...(onRevealChat ? { onRevealChat } : {})}
            />
          </WorkbenchLazySection>
          {/* Last of the inventory: an integration is the substrate the other
              two run on, not work in its own right, so it sits below them. */}
          <WorkbenchLazySection
            title="Integrations"
            icon="plugs-connected"
            meta={
              <FoldedIntegrationsSetupCount
                spaceId={spaceId}
                connectionRequests={actionCenter.lanes.connections}
              />
            }
          >
            <WorkbenchIntegrations
              spaceId={spaceId}
              spaceSlug={spaceSlug}
              connectionRequests={actionCenter.lanes.connections}
            />
          </WorkbenchLazySection>
          <WorkbenchCoachFold state={actionCenter} spaceId={spaceId} spaceSlug={spaceSlug} />
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
