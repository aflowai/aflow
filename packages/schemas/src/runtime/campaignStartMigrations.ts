import { z } from 'zod';

// ============================================================================
// Campaign start migrations
// ============================================================================

/** One memory doc a campaign start migration moved, content untouched. */
export const MovedMemoryDocSchema = z
  .object({
    fromPath: z.string(),
    toPath: z.string(),
  })
  .strict();
export type MovedMemoryDoc = z.infer<typeof MovedMemoryDocSchema>;

/** What one migration did when a campaign started: every doc it moved, and their count. */
export const CampaignStartMigrationReportSchema = z
  .object({
    migrationRef: z.string(),
    movedCount: z.number().int().min(0),
    moved: z.array(MovedMemoryDocSchema),
  })
  .strict();
export type CampaignStartMigrationReport = z.infer<typeof CampaignStartMigrationReportSchema>;

/**
 * What a migration reads. The `db` field is `unknown` for the reason the
 * runtime validator context gives: the registry does not pull in Drizzle.
 */
export interface CampaignStartMigrationContext {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  /** The validated config of the campaign about to be created. */
  config: Record<string, unknown>;
  db: unknown;
}

export type CampaignStartMigrationResult =
  { ok: true; moved: MovedMemoryDoc[] } | { ok: false; message: string };

/**
 * A one-pass structural step a skill's campaign contract names in
 * `startMigrations`. Campaign start runs it before it creates the campaign,
 * so a refusal creates nothing and a retry runs the pass again. It must be
 * idempotent: a second pass over a migrated space moves nothing.
 */
export type CampaignStartMigrationFn = (
  ctx: CampaignStartMigrationContext,
) => Promise<CampaignStartMigrationResult>;

const _migrations = new Map<string, CampaignStartMigrationFn>();

export function registerCampaignStartMigration(name: string, fn: CampaignStartMigrationFn): void {
  const existing = _migrations.get(name);
  if (existing && existing !== fn) {
    throw new Error(
      `campaignStartMigrations: "${name}" is already registered with a different function.`,
    );
  }
  _migrations.set(name, fn);
}

export function getCampaignStartMigration(name: string): CampaignStartMigrationFn | null {
  return _migrations.get(name) ?? null;
}

export function listCampaignStartMigrationNames(): string[] {
  return [..._migrations.keys()].sort();
}
