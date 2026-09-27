/**
 * Golden-dataset store (Plan 269 P1). One writer discipline over the
 * immutable-revision tables: every case add/update/remove bumps the dataset's
 * monotonic `datasetVersion`, closes the superseded revision's validity
 * interval, and inserts the new revision — atomically. Draft revisions
 * (promotions) never bump the version and never resolve into any version;
 * ratifying a draft is the ordinary update path (draft→active).
 *
 * The version math lives in the pure {@link planGoldenCaseWrite} so the
 * bump/close/insert invariants are testable without a database.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  GoldenCaseRevisionSchema,
  isLiveAtVersion,
  resolveDatasetVersion,
  type CaseRevisionInterval,
  type GoldenCase,
  type GoldenCaseContent,
  type GoldenCaseRevision,
  type GoldenDataset,
  type GoldenDatasetSummary,
  type TenantId,
} from '@aflow/schemas';
import {
  createTenantContext,
  goldenCaseRevisions,
  goldenDatasets,
  withTenantSchema,
  type GoldenCaseRevisionRow,
  type GoldenDatasetRow,
  type NewGoldenCaseRevisionRow,
} from '@aflow/database';

// ============================================================================
// Pure write planner
// ============================================================================

export interface GoldenCaseOpenRevision {
  revisionId: string;
  status: string;
}

export type GoldenCaseWriteAction = 'add' | 'update' | 'remove';

export interface GoldenCaseWriteError {
  ok: false;
  code: 'version_conflict' | 'case_not_found' | 'case_already_exists';
  detail: string;
}

export interface GoldenCaseWritePlan {
  ok: true;
  /** Dataset version after the write (unchanged for a draft discard). */
  newVersion: number;
  bumpsVersion: boolean;
  /** Revision whose validity interval closes (`removedInVersion = newVersion`). */
  closeRevisionId?: string;
  /** Insert a new ACTIVE revision with `addedInVersion = newVersion`. */
  insertActive: boolean;
}

export function planGoldenCaseWrite(params: {
  action: GoldenCaseWriteAction;
  currentVersion: number;
  /** The case's open revision (`removedInVersion IS NULL`), draft or active. */
  openRevision: GoldenCaseOpenRevision | null;
  expectedDatasetVersion?: number | undefined;
}): GoldenCaseWritePlan | GoldenCaseWriteError {
  const { action, currentVersion, openRevision, expectedDatasetVersion } = params;

  if (expectedDatasetVersion !== undefined && expectedDatasetVersion !== currentVersion) {
    return {
      ok: false,
      code: 'version_conflict',
      detail:
        `The dataset is at version ${String(currentVersion)}, not ${String(expectedDatasetVersion)}. ` +
        'It changed concurrently — reload and retry.',
    };
  }

  if (action === 'add') {
    if (openRevision !== null) {
      return {
        ok: false,
        code: 'case_already_exists',
        detail: 'The case already has an open revision — edit it instead of adding a duplicate.',
      };
    }
    return { ok: true, newVersion: currentVersion + 1, bumpsVersion: true, insertActive: true };
  }

  if (openRevision === null) {
    return {
      ok: false,
      code: 'case_not_found',
      detail: 'The case has no open revision in this dataset.',
    };
  }

  if (action === 'update') {
    // Ratifying a draft promotion is this same path: the draft closes, the
    // active revision enters at the bumped version.
    return {
      ok: true,
      newVersion: currentVersion + 1,
      bumpsVersion: true,
      closeRevisionId: openRevision.revisionId,
      insertActive: true,
    };
  }

  // remove — a draft never entered any version, so discarding it changes no
  // dataset content and must not bump the version.
  if (openRevision.status === 'draft') {
    return {
      ok: true,
      newVersion: currentVersion,
      bumpsVersion: false,
      closeRevisionId: openRevision.revisionId,
      insertActive: false,
    };
  }
  return {
    ok: true,
    newVersion: currentVersion + 1,
    bumpsVersion: true,
    closeRevisionId: openRevision.revisionId,
    insertActive: false,
  };
}

// ============================================================================
// Row mapping
// ============================================================================

function rowToDataset(row: GoldenDatasetRow): GoldenDataset {
  return {
    datasetId: row.id,
    spaceId: row.spaceId,
    workflowSlug: row.workflowSlug,
    datasetVersion: row.datasetVersion,
  };
}

/**
 * A row that cannot be read as a case, and why.
 *
 * Kept rather than thrown so one bad row does not take a whole dataset with
 * it — the read used to parse inside a map, and a single unreadable case
 * failed every eval batch for that skill. Kept rather than dropped because a
 * suite that silently loses a case measures less than it claims to, and
 * nothing downstream can tell the difference.
 */
export interface UnreadableCaseRow extends CaseRevisionInterval {
  title: string;
  reason: string;
}

export function tryRowToCaseRevision(
  row: GoldenCaseRevisionRow,
): { ok: true; revision: GoldenCaseRevision } | { ok: false; unreadable: UnreadableCaseRow } {
  try {
    return { ok: true, revision: rowToCaseRevision(row) };
  } catch (err) {
    return {
      ok: false,
      unreadable: {
        revisionId: row.id,
        caseId: row.caseId,
        title: row.title,
        reason: err instanceof Error ? err.message : String(err),
        // Carried so the row can be resolved to a version like any other. A
        // revision removed three versions ago must not refuse a batch at the
        // version that still reads cleanly.
        addedInVersion: row.addedInVersion,
        removedInVersion: row.removedInVersion,
        status: row.status,
      },
    };
  }
}

export function rowToCaseRevision(row: GoldenCaseRevisionRow): GoldenCaseRevision {
  return GoldenCaseRevisionSchema.parse({
    revisionId: row.id,
    caseId: row.caseId,
    datasetId: row.datasetId,
    addedInVersion: row.addedInVersion,
    ...(row.removedInVersion != null ? { removedInVersion: row.removedInVersion } : {}),
    status: row.status,
    case: {
      caseId: row.caseId,
      datasetId: row.datasetId,
      title: row.title,
      ...(row.notes != null ? { notes: row.notes } : {}),
      stratum: { scenario: row.scenario, direction: row.direction, tier: row.tier },
      trigger: row.triggerJson,
      fixture: row.fixtureJson,
      requirements: row.requirementsJson,
      expectations: row.expectationsJson,
      rubrics: row.rubricsJson,
      provenance: row.provenanceJson,
    },
  });
}

function contentToRevisionColumns(params: {
  spaceId: string;
  datasetId: string;
  caseId: string;
  content: GoldenCaseContent;
  status: 'draft' | 'active';
  addedInVersion: number;
  createdByUserId?: string | undefined;
}): NewGoldenCaseRevisionRow {
  const { spaceId, datasetId, caseId, content, status, addedInVersion, createdByUserId } = params;
  const fullCase: GoldenCase = { ...content, caseId, datasetId };
  return {
    spaceId,
    datasetId,
    caseId,
    addedInVersion,
    status,
    tier: fullCase.stratum.tier,
    direction: fullCase.stratum.direction,
    scenario: fullCase.stratum.scenario,
    source: fullCase.provenance.source,
    workflowRevision: fullCase.provenance.workflowRevision,
    title: fullCase.title,
    notes: fullCase.notes ?? null,
    triggerJson: fullCase.trigger,
    fixtureJson: fullCase.fixture,
    requirementsJson: fullCase.requirements,
    expectationsJson: fullCase.expectations,
    rubricsJson: fullCase.rubrics,
    provenanceJson: fullCase.provenance,
    createdByUserId: createdByUserId ?? null,
  };
}

// ============================================================================
// Reads
// ============================================================================

export async function listGoldenDatasets(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
): Promise<GoldenDatasetSummary[]> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(goldenDatasets)
      .where(eq(goldenDatasets.spaceId, spaceId))
      .orderBy(asc(goldenDatasets.workflowSlug));
    if (rows.length === 0) return [];

    const counts = await tx
      .select({
        datasetId: goldenCaseRevisions.datasetId,
        status: goldenCaseRevisions.status,
        count: sql<number>`count(*)::int`,
      })
      .from(goldenCaseRevisions)
      .where(
        and(eq(goldenCaseRevisions.spaceId, spaceId), isNull(goldenCaseRevisions.removedInVersion)),
      )
      .groupBy(goldenCaseRevisions.datasetId, goldenCaseRevisions.status);

    const byDataset = new Map<string, { active: number; draft: number }>();
    for (const row of counts) {
      const entry = byDataset.get(row.datasetId) ?? { active: 0, draft: 0 };
      if (row.status === 'active') entry.active = row.count;
      else if (row.status === 'draft') entry.draft = row.count;
      byDataset.set(row.datasetId, entry);
    }

    return rows.map((row) => ({
      ...rowToDataset(row),
      activeCaseCount: byDataset.get(row.id)?.active ?? 0,
      draftCount: byDataset.get(row.id)?.draft ?? 0,
    }));
  });
}

export interface GoldenDatasetBundle {
  dataset: GoldenDataset;
  resolvedVersion: number;
  /** Case revisions live at `resolvedVersion` (never drafts). */
  cases: GoldenCaseRevision[];
  /** Open draft revisions awaiting ratification. */
  drafts: GoldenCaseRevision[];
  /**
   * Rows that could not be read as cases. Present so a caller can decide: a
   * listing shows them for repair, a batch refuses rather than measuring the
   * rest and reporting a count that is quietly short.
   */
  unreadable: UnreadableCaseRow[];
}

export type LoadGoldenDatasetBundleResult =
  | { ok: true; bundle: GoldenDatasetBundle }
  | { ok: false; code: 'dataset_not_found' }
  | { ok: false; code: 'version_not_found'; currentVersion: number };

/**
 * A version above the dataset's head names no dataset state — the interval
 * math would silently return CURRENT content labeled as the future version,
 * so the guard lives here, where the head is known
 * (`resolveDatasetVersion` sees only intervals and cannot know it).
 */
export function resolveRequestedDatasetVersion(
  currentVersion: number,
  requested: number | undefined,
): { ok: true; version: number } | { ok: false; currentVersion: number } {
  if (requested === undefined) return { ok: true, version: currentVersion };
  if (requested > currentVersion) return { ok: false, currentVersion };
  return { ok: true, version: requested };
}

export async function loadGoldenDatasetBundle(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; workflowSlug: string; version?: number | undefined },
): Promise<LoadGoldenDatasetBundleResult> {
  const { spaceId, workflowSlug, version } = params;
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [datasetRow] = await tx
      .select()
      .from(goldenDatasets)
      .where(
        and(eq(goldenDatasets.spaceId, spaceId), eq(goldenDatasets.workflowSlug, workflowSlug)),
      )
      .limit(1);
    if (!datasetRow) return { ok: false as const, code: 'dataset_not_found' as const };

    const requested = resolveRequestedDatasetVersion(datasetRow.datasetVersion, version);
    if (!requested.ok) {
      return {
        ok: false as const,
        code: 'version_not_found' as const,
        currentVersion: requested.currentVersion,
      };
    }

    const revisionRows = await tx
      .select()
      .from(goldenCaseRevisions)
      .where(eq(goldenCaseRevisions.datasetId, datasetRow.id))
      .orderBy(asc(goldenCaseRevisions.createdAt));

    const revisions: GoldenCaseRevision[] = [];
    const unreadable: UnreadableCaseRow[] = [];
    for (const row of revisionRows) {
      const parsed = tryRowToCaseRevision(row);
      if (parsed.ok) revisions.push(parsed.revision);
      else unreadable.push(parsed.unreadable);
    }
    return {
      ok: true as const,
      bundle: {
        dataset: rowToDataset(datasetRow),
        resolvedVersion: requested.version,
        cases: resolveDatasetVersion(revisions, requested.version),
        drafts: revisions.filter((r) => r.status === 'draft' && r.removedInVersion === undefined),
        // Filtered by the same interval rule the cases use, not the throwing
        // resolver: an unreadable row is exactly the kind that could carry a
        // corrupt interval, and refusing the read over it is the failure this
        // whole path exists to avoid.
        unreadable: unreadable.filter((row) => isLiveAtVersion(row, requested.version)),
      },
    };
  });
}

// ============================================================================
// Writes
// ============================================================================

async function selectDatasetForUpdate(
  tx: PostgresJsDatabase,
  spaceId: string,
  workflowSlug: string,
): Promise<GoldenDatasetRow | null> {
  const [row] = await tx
    .select()
    .from(goldenDatasets)
    .where(and(eq(goldenDatasets.spaceId, spaceId), eq(goldenDatasets.workflowSlug, workflowSlug)))
    .limit(1)
    .for('update');
  return row ?? null;
}

async function selectOpenRevision(
  tx: PostgresJsDatabase,
  datasetId: string,
  caseId: string,
): Promise<GoldenCaseRevisionRow | null> {
  const [row] = await tx
    .select()
    .from(goldenCaseRevisions)
    .where(
      and(
        eq(goldenCaseRevisions.datasetId, datasetId),
        eq(goldenCaseRevisions.caseId, caseId),
        isNull(goldenCaseRevisions.removedInVersion),
      ),
    )
    .orderBy(desc(goldenCaseRevisions.addedInVersion))
    .limit(1);
  return row ?? null;
}

export type ApplyGoldenCaseWriteResult =
  | {
      ok: true;
      datasetId: string;
      caseId: string;
      datasetVersion: number;
      /** The new active revision, when the write inserted one. */
      revisionId?: string;
    }
  | GoldenCaseWriteError;

export async function applyGoldenCaseWrite(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    spaceId: string;
    workflowSlug: string;
    action: GoldenCaseWriteAction;
    /** Required for update/remove; assigned for add. */
    caseId?: string | undefined;
    /** Full case content for add/update. */
    content?: GoldenCaseContent | undefined;
    expectedDatasetVersion?: number | undefined;
    createdByUserId?: string | undefined;
  },
): Promise<ApplyGoldenCaseWriteResult> {
  const { spaceId, workflowSlug, action, expectedDatasetVersion, createdByUserId } = params;
  if (action !== 'remove' && params.content === undefined) {
    throw new Error(`applyGoldenCaseWrite: action '${action}' requires case content`);
  }
  if (action !== 'add' && params.caseId === undefined) {
    throw new Error(`applyGoldenCaseWrite: action '${action}' requires a caseId`);
  }
  const caseId = params.caseId ?? randomUUID();

  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    let datasetRow = await selectDatasetForUpdate(tx, spaceId, workflowSlug);
    if (!datasetRow && action !== 'add') {
      return {
        ok: false,
        code: 'case_not_found',
        detail: `No golden dataset exists for '${workflowSlug}' in this space.`,
      } satisfies GoldenCaseWriteError;
    }
    if (!datasetRow) {
      await tx.insert(goldenDatasets).values({ spaceId, workflowSlug }).onConflictDoNothing();
      datasetRow = await selectDatasetForUpdate(tx, spaceId, workflowSlug);
      if (!datasetRow) throw new Error('golden dataset creation raced and lost twice');
    }

    const openRow = await selectOpenRevision(tx, datasetRow.id, caseId);
    const plan = planGoldenCaseWrite({
      action,
      currentVersion: datasetRow.datasetVersion,
      openRevision: openRow ? { revisionId: openRow.id, status: openRow.status } : null,
      expectedDatasetVersion,
    });
    if (!plan.ok) return plan;

    if (plan.bumpsVersion) {
      await tx
        .update(goldenDatasets)
        .set({ datasetVersion: plan.newVersion, updatedAt: new Date() })
        .where(eq(goldenDatasets.id, datasetRow.id));
    }
    if (plan.closeRevisionId !== undefined) {
      await tx
        .update(goldenCaseRevisions)
        .set({ removedInVersion: plan.newVersion })
        .where(eq(goldenCaseRevisions.id, plan.closeRevisionId));
    }
    let revisionId: string | undefined;
    if (plan.insertActive) {
      const [inserted] = await tx
        .insert(goldenCaseRevisions)
        .values(
          contentToRevisionColumns({
            spaceId,
            datasetId: datasetRow.id,
            caseId,
            content: params.content!,
            status: 'active',
            addedInVersion: plan.newVersion,
            createdByUserId,
          }),
        )
        .returning({ id: goldenCaseRevisions.id });
      revisionId = inserted!.id;
    }

    return {
      ok: true,
      datasetId: datasetRow.id,
      caseId,
      datasetVersion: plan.newVersion,
      ...(revisionId !== undefined ? { revisionId } : {}),
    };
  });
}

/**
 * Add a whole suite in one transaction, at one new dataset version.
 *
 * Ratification is all-or-nothing, and a per-case write cannot be: a case that
 * fails partway leaves its predecessors active under a proposal that reports
 * failure, and a suite that succeeds mints one dataset version per case rather
 * than one per suite. Both were observed.
 */
export async function applyGoldenCaseAddBatch(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    spaceId: string;
    workflowSlug: string;
    contents: readonly GoldenCaseContent[];
    /**
     * Makes the write replayable. Ratification applies first and records the
     * proposal's status afterwards, so an apply that succeeds and then fails to
     * persist — or two operators ratifying at once — calls this again. Case ids
     * derived from this key collide on replay instead of inserting the suite
     * twice.
     */
    idempotencyKey: string;
    createdByUserId?: string | undefined;
  },
): Promise<{ datasetId: string; datasetVersion: number; caseIds: string[]; replayed: boolean }> {
  const { spaceId, workflowSlug, contents, idempotencyKey, createdByUserId } = params;
  if (contents.length === 0) throw new Error('applyGoldenCaseAddBatch: no cases');

  const caseIdFor = (index: number): string => {
    const hex = createHash('sha256')
      .update(`${idempotencyKey}:${String(index)}`)
      .digest('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `5${hex.slice(13, 16)}`,
      ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
      hex.slice(20, 32),
    ].join('-');
  };

  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    let datasetRow = await selectDatasetForUpdate(tx, spaceId, workflowSlug);
    if (!datasetRow) {
      await tx.insert(goldenDatasets).values({ spaceId, workflowSlug }).onConflictDoNothing();
      datasetRow = await selectDatasetForUpdate(tx, spaceId, workflowSlug);
      if (!datasetRow) throw new Error('golden dataset creation raced and lost twice');
    }

    const caseIds = contents.map((_, i) => caseIdFor(i));

    const existing = await tx
      .select({ addedInVersion: goldenCaseRevisions.addedInVersion })
      .from(goldenCaseRevisions)
      .where(
        and(
          eq(goldenCaseRevisions.datasetId, datasetRow.id),
          eq(goldenCaseRevisions.caseId, caseIds[0]!),
        ),
      )
      .limit(1);
    const already = existing[0];
    if (already) {
      return {
        datasetId: datasetRow.id,
        datasetVersion: already.addedInVersion,
        caseIds,
        replayed: true,
      };
    }

    const newVersion = datasetRow.datasetVersion + 1;
    await tx
      .update(goldenDatasets)
      .set({ datasetVersion: newVersion, updatedAt: new Date() })
      .where(eq(goldenDatasets.id, datasetRow.id));

    for (const [i, content] of contents.entries()) {
      await tx.insert(goldenCaseRevisions).values(
        contentToRevisionColumns({
          spaceId,
          datasetId: datasetRow.id,
          caseId: caseIds[i]!,
          content,
          status: 'active',
          addedInVersion: newVersion,
          createdByUserId,
        }),
      );
    }

    return { datasetId: datasetRow.id, datasetVersion: newVersion, caseIds, replayed: false };
  });
}

/**
 * Insert a DRAFT revision (promotion path, D14): a fresh case that enters no
 * dataset version and bumps nothing. Ratification is an ordinary update.
 */
export async function insertGoldenCaseDraft(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    spaceId: string;
    workflowSlug: string;
    content: GoldenCaseContent;
    createdByUserId?: string | undefined;
  },
): Promise<{ datasetId: string; caseId: string; revisionId: string; datasetVersion: number }> {
  const { spaceId, workflowSlug, content, createdByUserId } = params;
  const caseId = randomUUID();
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    let datasetRow = await selectDatasetForUpdate(tx, spaceId, workflowSlug);
    if (!datasetRow) {
      await tx.insert(goldenDatasets).values({ spaceId, workflowSlug }).onConflictDoNothing();
      datasetRow = await selectDatasetForUpdate(tx, spaceId, workflowSlug);
      if (!datasetRow) throw new Error('golden dataset creation raced and lost twice');
    }
    const [inserted] = await tx
      .insert(goldenCaseRevisions)
      .values(
        contentToRevisionColumns({
          spaceId,
          datasetId: datasetRow.id,
          caseId,
          content,
          status: 'draft',
          addedInVersion: datasetRow.datasetVersion,
          createdByUserId,
        }),
      )
      .returning({ id: goldenCaseRevisions.id });
    return {
      datasetId: datasetRow.id,
      caseId,
      revisionId: inserted!.id,
      datasetVersion: datasetRow.datasetVersion,
    };
  });
}
