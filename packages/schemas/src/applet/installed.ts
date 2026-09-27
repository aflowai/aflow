/**
 * Installed applet definitions — the space's tier-1 capability listing: which
 * applets exist here and how many live instances each has. One shape shared by
 * the SpaceContext applets section and the REST installed listing.
 */
import { z } from 'zod';

export const InstalledAppletSummarySchema = z.object({
  /** Head id — what ui.applet.instantiate takes to start an instance. */
  artifactId: z.string().uuid(),
  appletKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  liveInstances: z.number().int().nonnegative(),
});
export type InstalledAppletSummary = z.infer<typeof InstalledAppletSummarySchema>;

/** Raw join row: artifact head + its current version's definition column. */
export interface InstalledAppletDefinitionRow {
  artifactId: string;
  headName: string;
  /** Summary fields extracted in SQL — the full definition jsonb never leaves the database. */
  appletKey: string | null;
  name: string | null;
  description: string | null;
  semanticDescription: string | null;
  liveInstances: number;
}

function firstSentence(text: string): string {
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(text);
  return (match?.[0] ?? text).trim();
}

/**
 * Project raw head rows into summaries. Defensive against the jsonb column:
 * a row whose definition is absent or lacks a string appletKey is dropped —
 * it cannot be instantiated, so listing it would teach a dead capability.
 */
export function deriveInstalledAppletEntries(
  rows: readonly InstalledAppletDefinitionRow[],
): InstalledAppletSummary[] {
  const out: InstalledAppletSummary[] = [];
  for (const row of rows) {
    if (row.appletKey === null || row.appletKey.length === 0) continue;
    const name = row.name !== null && row.name.length > 0 ? row.name : row.headName;
    const description =
      row.semanticDescription !== null && row.semanticDescription.length > 0
        ? firstSentence(row.semanticDescription)
        : row.description !== null && row.description.length > 0
          ? row.description
          : undefined;
    out.push({
      artifactId: row.artifactId,
      appletKey: row.appletKey,
      name,
      ...(description !== undefined ? { description } : {}),
      liveInstances: row.liveInstances,
    });
  }
  return out;
}
