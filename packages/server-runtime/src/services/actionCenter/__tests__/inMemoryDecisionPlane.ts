import type { DecisionPlaneStore } from '../decisionPlane.js';

/**
 * The decision plane held in maps: assignments, notifications, and the people
 * who can be asked.
 * Notifications keep the same at-most-once tuple the real store enforces, so
 * a test that relies on dedupe is exercising the contract, not an accident.
 */
export function inMemoryDecisionPlane(members: string[] = []) {
  const assignments = new Map<string, string>();
  const notifications = new Map<string, Record<string, unknown>>();
  const membership = new Set(members);

  const store: DecisionPlaneStore = {
    async loadAssignments(_tenantId, _spaceId, itemIds) {
      return new Map(
        itemIds.filter((id) => assignments.has(id)).map((id) => [id, assignments.get(id) ?? '']),
      );
    },
    async saveAssignment(_tenantId, args) {
      assignments.set(args.itemId, args.assigneeUserId);
    },
    async canBeAsked(_tenantId, _spaceId, userId) {
      return membership.has(userId);
    },
    async notify(_tenantId, args) {
      const key = `${args.kind}|${args.subjectId}|${args.recipientUserId}`;
      if (!notifications.has(key)) notifications.set(key, args.payload ?? {});
    },
  };

  return { store, assignments, notifications, membership };
}
