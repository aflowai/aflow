import 'dotenv/config';

import {
  closeConnection,
  createTenantContext,
  getConnection,
  getDatabase,
  listTenantSchemas,
  resolveWorkflowForStart,
  spaces,
  users,
  withTenantSchema,
} from '@aflow/database';
import type { GoldenCaseContent, TenantId } from '@aflow/schemas';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { loadGoldenDatasetBundle } from '@aflow/cybernetic-runtime';

import { applyOperatorGoldenCaseWrite } from '../packages/server-runtime/src/services/operatorGoldenDatasetWrite.js';

/**
 * Install a repo-held starter case set into a space's golden dataset.
 *
 * Cases go through `applyOperatorGoldenCaseWrite` — the same authenticated
 * boundary the operator REST route uses — so every case is validated against
 * the skill's materialized contract and an undecidable one is refused rather
 * than stored. Writing the rows directly would skip that, and a case the
 * grader cannot decide is worse than a missing one: it produces a verdict
 * nobody can act on.
 *
 * Owning the set in the repo is deliberate at this stage. Six cases that can be
 * reinstalled, diffed and reviewed are how the MECHANICS get proven; capturing
 * cases from a rehearsal is how the set grows afterwards, and that surface is
 * Plan 300 P0.
 *
 *   NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/install-eval-cases.ts \
 *     --set cs-desk --space <spaceId> --operator <email>
 */

interface CaseSet {
  slug: string;
  build: (workflowRevision: number) => GoldenCaseContent[];
}

const SETS: Record<string, () => Promise<CaseSet>> = {
  'cs-desk': async () => {
    const { csDeskStarterCases } =
      await import('../packages/integration-simulator/src/csDesk/eval/cases.js');
    return { slug: 'cs-desk-conversation', build: csDeskStarterCases };
  },
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const setName = arg('set');
  const spaceId = arg('space');
  const operatorEmail = arg('operator');

  const load = setName ? SETS[setName] : undefined;
  if (!load || !spaceId || !operatorEmail) {
    console.error(
      `usage: install-eval-cases.ts --set <${Object.keys(SETS).join('|')}> --space <spaceId> --operator <email>`,
    );
    process.exitCode = 1;
    return;
  }

  const set = await load();
  const db = getDatabase();

  try {
    const tenants = await listTenantSchemas(getConnection());
    let tenantId: TenantId | undefined;
    for (const tenant of tenants) {
      const ctx = createTenantContext(tenant.tenantId);
      const rows = await withTenantSchema(db, ctx, async (tx: unknown) =>
        (tx as PostgresJsDatabase)
          .select({ id: spaces.id })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .limit(1),
      );
      if (rows[0]) {
        tenantId = tenant.tenantId;
        break;
      }
    }
    if (!tenantId) throw new Error(`No space ${spaceId} in any tenant`);
    const tenantCtx = createTenantContext(tenantId);

    // The dataset is the ruler, and 269 keeps its writes attributable to a
    // person. A script run by an operator is that person; it does not get to
    // write anonymously.
    const operatorRows = await withTenantSchema(db, tenantCtx, async (tx: unknown) =>
      (tx as PostgresJsDatabase)
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, operatorEmail))
        .limit(1),
    );
    const operatorUserId = operatorRows[0]?.id;
    if (!operatorUserId) throw new Error(`No user ${operatorEmail} in this tenant`);

    // Cases are pinned to the revision they were authored against, so a later
    // skill edit is visible as drift rather than silently re-interpreted.
    const workflow = await resolveWorkflowForStart(db, tenantId, spaceId, set.slug);
    if (!workflow) throw new Error(`No skill '${set.slug}' in this space — create it first`);
    const revision = (workflow as { revision?: number }).revision ?? 0;

    const cases = set.build(revision);
    console.log(
      `skill ${set.slug} @ revision ${String(revision)} — installing ${String(cases.length)} cases`,
    );

    // Re-running must UPDATE rather than duplicate. A set installed twice that
    // silently doubles is a dataset whose pass rate moves for no reason, and
    // the title is the only stable handle a repo-held case carries — its id is
    // store-assigned.
    const existing = await loadGoldenDatasetBundle(db, tenantId, {
      spaceId,
      workflowSlug: set.slug,
    });
    const idByTitle = new Map<string, string>();
    if (existing.ok) {
      for (const row of existing.bundle.cases) {
        const title = (row.case as { title?: string }).title;
        if (title) idByTitle.set(title, row.case.caseId);
      }
    }

    let installed = 0;
    for (const content of cases) {
      const priorId = idByTitle.get(content.title);
      const result = await applyOperatorGoldenCaseWrite({
        tenantId,
        spaceId,
        slug: set.slug,
        action: priorId ? 'update' : 'add',
        ...(priorId ? { caseId: priorId } : {}),
        content,
        operatorUserId,
        db,
      });
      if (result.ok) {
        installed += 1;
        const advisory =
          result.advisories.length > 0 ? ` (${String(result.advisories.length)} advisories)` : '';
        console.log(`  ✓ v${String(result.datasetVersion)} ${content.title}${advisory}`);
        for (const a of result.advisories) console.log(`      ! ${a.code}: ${a.detail}`);
      } else {
        console.log(`  ✗ ${content.title}`);
        console.log(`      ${result.code}: ${result.detail}`);
        for (const d of result.diagnostics ?? []) console.log(`      ! ${d.code}: ${d.detail}`);
      }
    }
    console.log(`installed ${String(installed)}/${String(cases.length)}`);
  } finally {
    await closeConnection();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
