/**
 * Which lanes a listing needs, and whether the deployment serving the Store
 * composes them.
 *
 * The requirement is derived from the operations the listing's own tasks name,
 * never declared beside them: a skill that gains a harness task gains the
 * requirement in the same edit, and no flag can disagree with the workflow it
 * describes. One shared catalog is served by both editions, so a listing whose
 * lane is absent is withheld rather than shown and refused at install — the
 * install is the first moment the operator would learn, and by then they have
 * chosen it.
 */
import {
  isOperationComposed,
  uncomposedOperationReason,
  type CatalogEntry,
  type ComposedLanes,
} from '@aflow/schemas';

import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';

/**
 * Every operation the listing's tasks are given: what an operation task runs,
 * and the surface an agent task starts its turn with.
 *
 * The promotable ceiling is deliberately out of it. That is what a task may
 * reach for, and the agent surface already withholds an uncomposed operation
 * from discovery — costing the task one option it never had, not the run.
 */
export function listingRequiredOperations(entry: CatalogEntry): string[] {
  if (entry.kind === 'space') return spaceTemplateRequiredOperations(entry.payload.bundleIds);
  if (entry.kind !== 'bundle') return [];
  return bundleRequiredOperations(entry.payload.skillCatalogIds);
}

/** A template runs what its bundles run, so it is withheld wherever one of them would be. */
function spaceTemplateRequiredOperations(bundleIds: readonly string[]): string[] {
  const operations = new Set<string>();
  for (const bundleId of bundleIds) {
    const bundle = getSkillBundleEntry(bundleId);
    if (!bundle) continue;
    for (const operationId of bundleRequiredOperations(bundle.skillCatalogIds)) {
      operations.add(operationId);
    }
  }
  return [...operations].sort();
}

function bundleRequiredOperations(skillCatalogIds: readonly string[]): string[] {
  const operations = new Set<string>();
  for (const skillCatalogId of skillCatalogIds) {
    const skill = getSkillCatalogEntry(skillCatalogId);
    if (!skill) continue;
    for (const task of skill.bundle.workflow.tasks) {
      if (task.operation !== undefined) operations.add(task.operation);
      for (const operationId of task.context?.capabilities?.operations ?? []) {
        operations.add(operationId);
      }
      for (const tool of task.context?.tools ?? []) operations.add(tool);
    }
  }
  return [...operations].sort();
}

/**
 * Why this deployment cannot run the listing, in the same words a refused
 * operation gets — the remedy differs by edition, and the operator reading an
 * install refusal is owed the one that applies to theirs.
 */
export function uncomposedListingReason(entry: CatalogEntry, lanes: ComposedLanes): string | null {
  for (const operationId of listingRequiredOperations(entry)) {
    const reason = uncomposedOperationReason(operationId, lanes);
    if (reason !== null) return reason;
  }
  return null;
}

/** Whether every lane the listing's tasks need is composed here. */
export function isListingComposed(entry: CatalogEntry, lanes: ComposedLanes): boolean {
  return listingRequiredOperations(entry).every((operationId) =>
    isOperationComposed(operationId, lanes),
  );
}
