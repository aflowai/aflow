'use client';

import { useMemo } from 'react';
import { Column } from '@aflow/design-system';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useActionCenter } from '../../hooks/use-action-center.js';
import { useSpaceWorkflowRuns } from '../../hooks/use-space-workflow-runs.js';
import { WorkbenchNeedsAttention, waitingOnLabel } from './WorkbenchNeedsAttention.js';
import { WorkbenchArmedTriggers } from './WorkbenchArmedTriggers.js';
import { useSpacePeople } from '../../hooks/use-space-people.js';
import { WorkbenchCoach } from './WorkbenchCoach.js';
import { WorkbenchSkills, type WorkbenchSkill } from './WorkbenchSkills.js';
import { WorkbenchApplets } from './WorkbenchApplets.js';
import { WorkbenchAgents } from './WorkbenchAgents.js';
import { WorkbenchIntegrations } from './WorkbenchIntegrations.js';
import { WorkbenchRecentConversations } from './WorkbenchRecentConversations.js';

interface WorkflowListItem {
  slug: string;
  name: string;
  mode?: string;
  system?: boolean;
  purgedAt?: string | null;
  archivedAt?: string | null;
}

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

  const skillsQuery = useApiQuery<{ workflows: WorkflowListItem[] }>({
    key: ['space', spaceId, 'workflows', 'all'],
    path: `/spaces/${spaceId}/workflows?archived=true`,
    spaceId,
    staleTime: 30_000,
    enabled: !!spaceId,
  });

  const skills = useMemo<WorkbenchSkill[]>(
    () =>
      (skillsQuery.data?.workflows ?? [])
        .filter((w) => !w.system && !w.purgedAt)
        .map((w) => ({
          slug: w.slug,
          name: w.name,
          ...(w.mode ? { mode: w.mode } : {}),
          archivedAt: w.archivedAt ?? null,
        })),
    [skillsQuery.data],
  );

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
          <WorkbenchArmedTriggers state={actionCenter} spaceSlug={spaceSlug} />
          <WorkbenchSkills
            skills={skills}
            spaceId={spaceId}
            spaceSlug={spaceSlug}
            activeRuns={runsState.runs}
            waitingOnByRun={waitingOnByRun}
            loading={skillsQuery.isLoading}
            onRun={(skill) => {
              seed(`Run the "${skill.name}" skill. `);
            }}
            {...(onRevealChat ? { onRevealChat } : {})}
          />
          <WorkbenchApplets
            spaceId={spaceId}
            spaceSlug={spaceSlug}
            {...(onRevealChat ? { onRevealChat } : {})}
          />
          {/* Below the capabilities and above the substrate: an agent is someone
              who works here rather than something the space can do, so it does
              not belong among Skills — but it is still inventory, not plumbing. */}
          <WorkbenchAgents
            spaceId={spaceId}
            spaceSlug={spaceSlug}
            {...(onRevealChat ? { onRevealChat } : {})}
          />
          {/* Last of the inventory: an integration is the substrate the other
              two run on, not work in its own right, so it sits below them. */}
          <WorkbenchIntegrations spaceId={spaceId} spaceSlug={spaceSlug} />
          <WorkbenchCoach state={actionCenter} spaceId={spaceId} spaceSlug={spaceSlug} />
        </Column>
      </div>
      {/* The floor of the pane. It sizes itself (see the component) rather than
          sitting in a wrapper here, because a wrapper would hold its floor open
          on a space that has no conversations to show yet. */}
      <WorkbenchRecentConversations
        spaceId={spaceId}
        spaceSlug={spaceSlug}
        {...(onRevealChat ? { onRevealChat } : {})}
      />
    </Column>
  );
}
