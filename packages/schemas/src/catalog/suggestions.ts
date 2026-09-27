import { getAllOperations } from './registry.js';

const MAX_SUGGESTIONS = 5;

/**
 * Suggest known operations that are close to an unknown operation ID.
 *
 * Strategy (in priority order):
 * 1. Same stepType.group prefix → list operations in that group
 * 2. Same stepType prefix → list groups
 * 3. Same verb in any operation → mention them
 *
 * Returns up to 5 operation IDs sorted by relevance.
 */
export function suggestOperations(unknownId: string): string[] {
  const parts = unknownId.split('.');
  const allOpsMap = getAllOperations();
  const agentOps = [...allOpsMap.values()].filter((op) => op.agentTool && !op.internal);

  // Strategy 1: Exact stepType.group match (e.g., "api.call" matches "api.http")
  if (parts.length >= 2) {
    const prefix = `${parts[0]}.${parts[1]}`;
    const groupMatches = agentOps.filter((op) => op.operationId.startsWith(`${prefix}.`));
    if (groupMatches.length > 0) {
      return groupMatches.slice(0, MAX_SUGGESTIONS).map((op) => op.operationId);
    }
  }

  // Strategy 2: Same stepType (first segment)
  if (parts.length >= 1) {
    const stepType = parts[0]!;
    const stepTypeMatches = agentOps.filter((op) => op.stepType === stepType);
    if (stepTypeMatches.length > 0 && stepTypeMatches.length <= 15) {
      return stepTypeMatches.slice(0, MAX_SUGGESTIONS).map((op) => op.operationId);
    }
    // Too many — group them
    if (stepTypeMatches.length > 15) {
      const groups = new Set(stepTypeMatches.map((op) => `${op.stepType}.${op.group ?? '*'}`));
      return [...groups].slice(0, MAX_SUGGESTIONS).map((g) => `${g}.*`);
    }
  }

  // Strategy 3: Same verb (last segment)
  if (parts.length >= 1) {
    const verb = parts[parts.length - 1]!;
    const verbMatches = agentOps.filter((op) => op.verb === verb);
    if (verbMatches.length > 0) {
      return verbMatches.slice(0, MAX_SUGGESTIONS).map((op) => op.operationId);
    }
  }

  return [];
}
