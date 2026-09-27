'use client';

import { useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ListingAvatar, Row, Text, Tooltip } from '@aflow/design-system';

import { useFlows } from '../../hooks/use-flows.js';
import { spaceRoute } from '../../lib/space-routes.js';
import type { Flow } from '../../lib/types.js';
import { WorkbenchEmptyRow, WorkbenchSection } from './WorkbenchSection.js';

/**
 * Who else works here (Plan 293 §9.4) — the space's operator-authored agents.
 *
 * The board had no answer to that question, because until a simulated subject
 * arrived the answer was always "the Helmsman, and machinery you do not address
 * directly". A custom agent is neither: not a skill (a capability Helmsman
 * invokes) and not a platform role, but someone you talk to, with its own
 * prompt, tools and voice.
 *
 * Inventory plus one door, deliberately. Everything else about an agent — its
 * definition, its past conversations — already lives at `/agents/{id}`; what was
 * missing was a way to find it from the board at all.
 */
export function WorkbenchAgents({
  spaceId,
  spaceSlug,
  onRevealChat,
}: {
  spaceId: string;
  spaceSlug: string;
  onRevealChat?: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { flows, isLoading } = useFlows(spaceId);

  /**
   * Switching agent keeps the rehearsal pin, when there is one.
   *
   * Dropping it would silently take the next chat out of the simulation, and
   * carrying it is the comparison worth having: the same world and the same
   * caller, answered by a different agent.
   */
  const chatParams = useCallback(
    (agentId: string) => {
      const params = new URLSearchParams();
      params.set('agentId', agentId);
      for (const key of ['sim', 'persona', 'baseline']) {
        const value = searchParams.get(key);
        if (value) params.set(key, value);
      }
      return params.toString();
    },
    [searchParams],
  );

  // Platform roles are addressed through their own surfaces — the Helmsman IS
  // this chat, the Runner only ever starts as a skill's executor — so listing
  // them here would offer a door to somewhere the operator already is.
  const agents = useMemo(() => flows.filter((flow) => !flow.systemRole && !flow.system), [flows]);

  const empty = agents.length === 0;
  if (empty && isLoading) return null;

  return (
    <WorkbenchSection
      title="Agents"
      icon="robot"
      meta={
        agents.length > 0 ? (
          <Text size="xs" variant="muted">
            {agents.length}
          </Text>
        ) : null
      }
      link={{
        href: spaceRoute(spaceSlug, '/agents'),
        label: empty ? 'Create one' : 'Manage',
      }}
    >
      {empty ? (
        <WorkbenchEmptyRow label="No agents yet" />
      ) : (
        <Row gap="xs" wrap>
          {agents.map((agent) => (
            <AgentChip
              key={agent.agentId}
              agent={agent}
              onOpen={() => {
                onRevealChat?.();
                router.push(spaceRoute(spaceSlug, `/chat?${chatParams(agent.agentId)}`));
              }}
            />
          ))}
        </Row>
      )}
    </WorkbenchSection>
  );
}

/**
 * Opening an agent navigates IN PLACE rather than to a new tab, unlike every
 * other side trip on the board: switching who you are talking to is switching
 * your main context, not looking something up (Plan 228 §3.4).
 */
function AgentChip({ agent, onOpen }: { agent: Flow; onOpen: () => void }) {
  return (
    <Tooltip content={agent.description ? `${agent.name} — ${agent.description}` : agent.name}>
      <button
        type="button"
        onClick={onOpen}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          maxWidth: 180,
          padding: '2px var(--space-2) 2px 2px',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-surface-2)',
          color: 'var(--color-text-primary)',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        <ListingAvatar
          name={agent.name}
          kind="agent"
          seed={agent.agentId}
          size="sm"
          style={{ borderRadius: 'var(--radius-full)' }}
        />
        <Text size="xs" truncate style={{ minWidth: 0 }}>
          {agent.name}
        </Text>
      </button>
    </Tooltip>
  );
}
