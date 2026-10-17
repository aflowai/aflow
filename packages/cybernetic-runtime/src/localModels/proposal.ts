/**
 * The approval request for a change Helmsman proposes to the runtime (Plan 323
 * D10). Built from one diagnosis, when the change is asked for and again when
 * an approved change is about to run: the hash covers the change and whether
 * it reloads the asking conversation's model, so an approval acts only on the
 * change its card showed, and one whose reach moved since asks again.
 */
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, spaces, withTenantSchema } from '@aflow/database';
import {
  stableHash,
  type DirectiveModelDefaults,
  type LocalModelWriteApprovalRequestPayload,
  type LocalRuntimeChange,
  type LocalRuntimeDiagnostics,
  type TenantId,
} from '@aflow/schemas';

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

export async function readSpaceModelDefaults(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<DirectiveModelDefaults | undefined> {
  const [row] = (await withTenantSchema(
    db,
    createTenantContext(tenantId as TenantId),
    async (tx: unknown) =>
      (tx as PostgresJsDatabase)
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1),
  )) as Array<{ directives: { modelDefaults?: DirectiveModelDefaults } | null }>;
  return row?.directives?.modelDefaults;
}

function notesFor(change: LocalRuntimeChange, diagnostics: LocalRuntimeDiagnostics): string[] {
  if (change.action === 'set_context') {
    const used = diagnostics.models.filter((m) => m.roles.length > 0);
    return [
      change.contextTokens === null
        ? 'Each model gets the largest window that fits this computer.'
        : `Requests get ${String(change.contextTokens)} tokens of window, whatever the machine fits.`,
      ...used.map(
        (m) =>
          `${m.displayName} now fits ${
            m.fit.largestFittingWindow !== null
              ? `${String(m.fit.largestFittingWindow)} tokens`
              : 'an unknown window'
          } on this computer.`,
      ),
    ];
  }
  const model = diagnostics.models.find((m) => m.model === change.model);
  if (!model) return [];
  const gpu = diagnostics.machine?.gpuWorkingSetBytes ?? null;
  switch (change.action) {
    case 'pull': {
      const free = diagnostics.machine?.freeDiskBytes ?? null;
      return [
        model.downloadBytes !== null
          ? `Downloads ${gb(model.downloadBytes)}${free !== null ? ` of the ${gb(free)} free on disk` : ''}.`
          : 'Its download size is not known before it starts.',
        `Fit on this computer: ${model.fit.status.replaceAll('_', ' ')}.`,
      ];
    }
    case 'delete':
      return [
        `Frees ${model.downloadBytes !== null ? gb(model.downloadBytes) : 'its'} disk; downloading it again takes as much.`,
        ...(model.roles.length > 0
          ? [`${model.roles.join(', ')} cannot run until it is downloaded again.`]
          : []),
      ];
    case 'warm':
      return [
        model.fit.bytesAtWindow !== null
          ? `Takes about ${gb(model.fit.bytesAtWindow)}${gpu !== null ? ` of the ${gb(gpu)} the GPU allows` : ''} at a ${String(model.fit.window)}-token window.`
          : `Loads at a ${String(model.fit.window)}-token window.`,
      ];
    case 'unload':
      return [
        model.loaded
          ? `Frees ${gb(model.loaded.sizeBytes)} and every conversation it holds.`
          : 'It is not loaded now; nothing is freed.',
      ];
  }
}

/** Changes that end requests running on the runtime. */
const ENDS_REQUESTS: ReadonlySet<LocalRuntimeChange['action']> = new Set(['unload', 'delete']);

export function localRuntimeChangeRequest(input: {
  operationId: string;
  change: LocalRuntimeChange;
  diagnostics: LocalRuntimeDiagnostics;
  inFlightRequests: number;
  /** The model the asking conversation runs on, when it runs on one here. */
  askingModel: string | undefined;
}): Omit<LocalModelWriteApprovalRequestPayload, 'decidedBefore'> {
  const { change, diagnostics } = input;
  const model =
    'model' in change ? diagnostics.models.find((m) => m.model === change.model) : undefined;
  const impact = {
    inFlightRequests: ENDS_REQUESTS.has(change.action) ? input.inFlightRequests : 0,
    ownConversationReloads:
      'model' in change && ENDS_REQUESTS.has(change.action) && input.askingModel === change.model,
    notes: notesFor(change, diagnostics),
  };
  return {
    kind: 'write_approval',
    target: 'local_model',
    change,
    ...(model ? { modelName: model.displayName } : {}),
    runtimeUrl: diagnostics.runtime.baseUrl,
    impact,
    // What moves by the second — free disk, a loaded model's growing cache,
    // the requests in flight on the runtime, which no lease ties to a model —
    // informs the card and stays out of the hash, or an approved change would
    // rarely find the request it approved.
    requestHash: stableHash({
      operationId: input.operationId,
      change,
      ownConversationReloads: impact.ownConversationReloads,
    }),
  };
}
