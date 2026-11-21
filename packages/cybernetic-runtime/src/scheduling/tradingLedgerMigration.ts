import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, like, or } from 'drizzle-orm';
import {
  registerCampaignStartMigration,
  type CampaignStartMigrationContext,
  type CampaignStartMigrationResult,
  type MovedMemoryDoc,
  type TenantId,
} from '@aflow/schemas';
import {
  createMemoryDirRepository,
  createTenantContext,
  memoryDocs,
  withTenantSchema,
} from '@aflow/database';
import { listCampaigns } from '../campaigns.js';
import { resolveSkillForWorkflow } from '../skill.js';
import { THESIS_OPEN_PREFIX, THESIS_RESOLVED_PREFIX } from './tradingArmTable.js';

/**
 * The thesis ledger's one-pass migration, run when a campaign of a skill that
 * names it starts. A new campaign has written no thesis doc yet, so every doc
 * under the live ledger paths belongs to an earlier campaign or to a skill
 * version from before hypothesis arms. The pass moves each one, content
 * untouched, under one archive folder, and leaves the live ledger empty. The
 * runtime then reads only docs the running campaign wrote.
 */
export const TRADING_THESIS_LEDGER_ARCHIVE_REF = 'trading.archive-thesis-ledger' as const;

export const THESIS_ARCHIVE_ROOT = '/portfolio/archive/theses/';

const LIVE_LEDGER_FOLDERS = [
  { prefix: THESIS_OPEN_PREFIX, folder: 'open/' },
  { prefix: THESIS_RESOLVED_PREFIX, folder: 'resolved/' },
] as const;

/**
 * The folder one pass archives into, named for the instant it ran and the
 * regime it ran for. Paths are unique per space even among deleted docs, so
 * every pass gets a folder of its own.
 */
export function thesisArchiveFolder(startedAt: Date, regimeName: string): string {
  const stamp = startedAt
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `${THESIS_ARCHIVE_ROOT}${stamp}-${regimeName}/`;
}

/** Where each live ledger doc moves, keeping its path below `open/` or `resolved/`. */
export function planThesisLedgerArchive(
  livePaths: readonly string[],
  archiveFolder: string,
): MovedMemoryDoc[] {
  return livePaths
    .flatMap((fromPath) => {
      const live = LIVE_LEDGER_FOLDERS.find(({ prefix }) => fromPath.startsWith(prefix));
      if (!live) return [];
      return [
        { fromPath, toPath: `${archiveFolder}${live.folder}${fromPath.slice(live.prefix.length)}` },
      ];
    })
    .sort((a, b) => (a.fromPath < b.fromPath ? -1 : a.fromPath > b.fromPath ? 1 : 0));
}

/** An active campaign of a skill that keeps its theses in this space's ledger. */
export interface ThesisLedgerHolder {
  campaignId: string;
  workflowSlug: string;
  regimeName: string | null;
}

/** What the pass reads and moves. The database store is the only production one. */
export interface ThesisLedgerArchiveStore {
  ledgerHolders(): Promise<ThesisLedgerHolder[]>;
  /** Move the live docs as `plan` maps their paths, in one transaction, and return the moves. */
  moveLiveDocs(plan: (livePaths: string[]) => MovedMemoryDoc[]): Promise<MovedMemoryDoc[]>;
}

/**
 * Archive the live ledger for a campaign about to start. Another active
 * campaign that keeps its theses here would lose its open theses to the
 * archive, so the pass refuses while one runs: the ledger serves one campaign
 * at a time.
 */
export async function archiveThesisLedger(
  store: ThesisLedgerArchiveStore,
  scope: { regimeName: string; startedAt: Date },
): Promise<CampaignStartMigrationResult> {
  const holders = await store.ledgerHolders();
  if (holders.length > 0) {
    const named = holders
      .map((h) => `"${h.regimeName ?? h.campaignId}" of ${h.workflowSlug} (${h.campaignId})`)
      .join(', ');
    return {
      ok: false,
      message: `the thesis ledger serves one campaign at a time, and the campaign ${named} still keeps its theses in it. End that campaign with workflow.campaign.end, then start this one.`,
    };
  }
  const folder = thesisArchiveFolder(scope.startedAt, scope.regimeName);
  const moved = await store.moveLiveDocs((livePaths) => planThesisLedgerArchive(livePaths, folder));
  return { ok: true, moved };
}

function databaseArchiveStore(ctx: CampaignStartMigrationContext): ThesisLedgerArchiveStore {
  const db = ctx.db as PostgresJsDatabase;
  const tenantContext = createTenantContext(ctx.tenantId as TenantId);
  return {
    async ledgerHolders() {
      const active = await listCampaigns(db, ctx.tenantId, {
        spaceId: ctx.spaceId,
        status: 'active',
        limit: 100,
      });
      const holders: ThesisLedgerHolder[] = [];
      const sharesLedger = new Map<string, boolean>();
      for (const campaign of active) {
        let shares = sharesLedger.get(campaign.workflowSlug);
        if (shares === undefined) {
          const skill = await resolveSkillForWorkflow(
            { db, tenantId: ctx.tenantId, spaceId: ctx.spaceId },
            campaign.workflowSlug,
          );
          shares =
            skill?.manifest.campaign?.startMigrations?.includes(
              TRADING_THESIS_LEDGER_ARCHIVE_REF,
            ) ?? false;
          sharesLedger.set(campaign.workflowSlug, shares);
        }
        if (!shares) continue;
        const regimeName = campaign.config?.['regimeName'];
        holders.push({
          campaignId: campaign.campaignId,
          workflowSlug: campaign.workflowSlug,
          regimeName: typeof regimeName === 'string' ? regimeName : null,
        });
      }
      return holders;
    },
    async moveLiveDocs(plan) {
      return withTenantSchema(db, tenantContext, async (tx) => {
        const rows = await tx
          .select({ path: memoryDocs.path })
          .from(memoryDocs)
          .where(
            and(
              eq(memoryDocs.spaceId, ctx.spaceId),
              isNull(memoryDocs.deletedAt),
              or(
                like(memoryDocs.path, `${THESIS_OPEN_PREFIX}%`),
                like(memoryDocs.path, `${THESIS_RESOLVED_PREFIX}%`),
              ),
            ),
          )
          .for('update');
        const moves = plan(rows.map((row) => row.path));
        const dirs = createMemoryDirRepository(tx, tenantContext, { inTransaction: true });
        const now = new Date();
        for (const move of moves) {
          await tx
            .update(memoryDocs)
            .set({ path: move.toPath, updatedAt: now })
            .where(
              and(
                eq(memoryDocs.spaceId, ctx.spaceId),
                eq(memoryDocs.path, move.fromPath),
                isNull(memoryDocs.deletedAt),
              ),
            );
          await dirs.ensureParentDirs(move.toPath, { spaceId: ctx.spaceId });
        }
        return moves;
      });
    },
  };
}

async function thesisLedgerArchiveMigration(
  ctx: CampaignStartMigrationContext,
): Promise<CampaignStartMigrationResult> {
  const regimeName = ctx.config['regimeName'];
  if (typeof regimeName !== 'string' || regimeName.length === 0) {
    return {
      ok: false,
      message:
        'the campaign config has no regimeName, so the archive folder for the earlier thesis docs cannot be named.',
    };
  }
  return archiveThesisLedger(databaseArchiveStore(ctx), { regimeName, startedAt: new Date() });
}

registerCampaignStartMigration(TRADING_THESIS_LEDGER_ARCHIVE_REF, thesisLedgerArchiveMigration);
