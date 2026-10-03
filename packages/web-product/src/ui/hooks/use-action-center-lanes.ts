// The web app uses a hand-written mirror of `ActionCenterItem` in
// `use-action-center-types` (kept slim to avoid pulling the full
// `@aflow/schemas` build into the client bundle). Match the
// hook's import so the partition's output type is assignment-
// compatible with the consumer — Zod's inferred type has
// `readonly relatesTo` which doesn't widen to the mirror's
// mutable shape.
import type { ActionCenterItem } from './use-action-center-types.js';

export interface ActionCenterLanes {
  approvals: ActionCenterItem[];
  coachProposals: ActionCenterItem[];
  inputs: ActionCenterItem[];
  platformIssues: ActionCenterItem[];
  connections: ActionCenterItem[];
  /** Told, not asked. Rendered apart from anything that claims attention. */
  notices: ActionCenterItem[];
}

export function partitionLanes(items: readonly ActionCenterItem[]): ActionCenterLanes {
  const approvals: ActionCenterItem[] = [];
  const coachProposals: ActionCenterItem[] = [];
  const inputs: ActionCenterItem[] = [];
  const platformIssues: ActionCenterItem[] = [];
  const connections: ActionCenterItem[] = [];
  const notices: ActionCenterItem[] = [];
  for (const it of items) {
    switch (it.kind) {
      case 'human_input':
        inputs.push(it);
        break;
      case 'human_approval':
        approvals.push(it);
        break;
      case 'ratification':
        coachProposals.push(it);
        break;
      case 'platform_issue':
        platformIssues.push(it);
        break;
      case 'needs_oauth_consent':
        connections.push(it);
        break;
      case 'write_approval':
        approvals.push(it);
        break;
      case 'session_invitation':
        approvals.push(it);
        break;
      case 'browser_handoff':
        // A person is needed at the window, not a decision.
        inputs.push(it);
        break;
      case 'coach_activity':
        // No Action Center lane — coach activity surfaces elsewhere (see ActionCenterPanel).
        break;
      case 'trigger_armed':
        // Told, not asked. There is nothing to approve, so it goes to a lane
        // that renders apart from the attention count rather than into an
        // approval lane, where an ordinary event would read as a decision.
        notices.push(it);
        break;
      default: {
        // Exhaustiveness: a new item kind must be routed to a lane explicitly,
        // never silently dropped (the write_approval card was unreachable for
        // exactly this reason).
        const _exhaustive: never = it.kind;
        void _exhaustive;
        break;
      }
    }
  }
  return { approvals, coachProposals, inputs, platformIssues, connections, notices };
}
