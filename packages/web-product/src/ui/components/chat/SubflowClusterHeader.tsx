'use client';

import { Icon } from '@aflow/design-system';

/**
 * Header rendered once at the top of a consecutive run of sub-agent messages.
 *
 * Two shapes:
 * - Delegation (`label` set): "Delegated agent · <role|name>" — the role for
 *   platform agents (Helmsman/Runner/Coach), the agent name for custom ones.
 * - Workflow subflow (`label` absent): the `${slug} › ${task}` path the reducer
 *   packs into `source`. The workflow span shrinks first under tight widths,
 *   since the task name is the higher-information half.
 */
export function SubflowClusterHeader({
  source,
  label,
}: {
  source: string;
  label?: string | undefined;
}) {
  if (label) {
    return (
      <div className="chat-subflow-label">
        <Icon name="git-branch" size="xs" />
        <span className="chat-subflow-label__path">
          <span className="chat-subflow-label__kind">Delegated agent</span>
          <span className="chat-subflow-label__sep">·</span>
          <span className="chat-subflow-label__task">{label}</span>
        </span>
      </div>
    );
  }

  // Reducer formats `${slug} › ${task}` (or just slug). Split on the first " › ".
  const sepIdx = source.indexOf(' › ');
  const workflow = sepIdx >= 0 ? source.slice(0, sepIdx) : source;
  const task = sepIdx >= 0 ? source.slice(sepIdx + 3) : '';

  return (
    <div className="chat-subflow-label">
      <Icon name="git-branch" size="xs" />
      <span className="chat-subflow-label__path">
        <span className="chat-subflow-label__workflow">{workflow}</span>
        {task && (
          <>
            <span className="chat-subflow-label__sep">›</span>
            <span className="chat-subflow-label__task">{task}</span>
          </>
        )}
      </span>
    </div>
  );
}
