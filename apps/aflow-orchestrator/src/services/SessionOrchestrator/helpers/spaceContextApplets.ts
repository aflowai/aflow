import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { InstalledAppletSummary, SpaceContextAppletsSection, TenantId } from '@aflow/schemas';
import { deriveInstalledAppletEntries, SPACE_CONTEXT_LIMITS } from '@aflow/schemas';
import { createTenantContext, listInstalledAppletDefinitions } from '@aflow/database';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';

export const APPLETS_GUIDANCE =
  'Applets are durable shared work items (boards, games, trackers) people and agents operate ' +
  'together through declared actions. Start one with ui.applet.instantiate {artifactId}; live ' +
  'instances and their actions surface automatically. ui.applet.list browses live instances; ' +
  'ui.applet.get reads one — its result carries the current board, analysis, and recent actions, ' +
  'so when nudged or asked to act, read first. The board renders inline in chat ' +
  'automatically when you instantiate, read, or act on an instance — never re-describe it in ' +
  'prose. Your actions always target the current instance (the one you last instantiated, read, ' +
  'or were woken from). Keep one live instance per activity: when asked to start fresh while ' +
  'another instance of the same applet is active, first end the old one through one of its own ' +
  'ending actions (read it to make it current, then act), or tell the user both exist. The ' +
  'applet page (navigation `applet` route) is for opening a board outside this chat.';

export function composeAppletsSection(
  entries: InstalledAppletSummary[],
): SpaceContextAppletsSection | undefined {
  if (entries.length === 0) return undefined;
  const cap = SPACE_CONTEXT_LIMITS.applets;
  const truncated = entries.length > cap;
  return {
    installed: truncated ? entries.slice(0, cap) : entries,
    total: entries.length,
    ...(truncated ? { truncated: true } : {}),
    guidance: truncated
      ? `${APPLETS_GUIDANCE} ${entries.length - cap} more installed applets not shown — use ui.artifact.list with kind "applet" to enumerate all.`
      : `${APPLETS_GUIDANCE} These are all applets installed in this space.`,
  };
}

/** Returns undefined (after a warn) on failure — the section is additive, never load-bearing for the turn. */
export async function buildSpaceContextAppletsSection(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<SpaceContextAppletsSection | undefined> {
  try {
    const rows = await listInstalledAppletDefinitions(
      db,
      createTenantContext(tenantId as TenantId),
      spaceId,
    );
    return composeAppletsSection(deriveInstalledAppletEntries(rows));
  } catch (err) {
    getOrchestratorLogger().warn(
      `[spaceContext] applets section failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
