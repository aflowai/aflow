#!/usr/bin/env -S npx tsx
import 'dotenv/config';
import { getConnection, closeConnection, listTenantSchemas } from '@aflow/database';
import {
  PLATFORM_AGENT_IDS,
  PLATFORM_WORKFLOW_SLUGS,
  PLATFORM_SKILL_IDS,
} from '@aflow/platform-artifacts';

const execute = process.argv.includes('--execute');

async function main() {
  console.log(`\n=== Plan 106: Cleanup Seeded Platform Artifacts ===`);
  console.log(`Mode: ${execute ? 'EXECUTE (will delete)' : 'DRY RUN (report only)'}\n`);

  const sql = getConnection();
  const tenants = await listTenantSchemas(sql);

  const platformAgentIds = [...PLATFORM_AGENT_IDS];
  const platformWorkflowSlugs = [...PLATFORM_WORKFLOW_SLUGS];
  const platformSkillIds = [...PLATFORM_SKILL_IDS];

  let totalAgentRows = 0;
  let totalWorkflowDocs = 0;
  let totalManifestDocs = 0;
  let totalEvalDocs = 0;

  for (const tenant of tenants) {
    const schema = tenant.schemaName;
    console.log(`\n--- Tenant: ${schema} ---`);

    await sql.unsafe(`SET search_path TO "${schema}"`);
    try {
      // 1. Check for seeded agent_definitions rows
      const agentRows = await sql`
        SELECT agent_id, version, created_by
        FROM agent_definitions
        WHERE agent_id = ANY(${platformAgentIds})
      `;

      if (agentRows.length > 0) {
        const systemRows = agentRows.filter(
          (r: Record<string, unknown>) => r.created_by === 'system',
        );
        const nonSystemRows = agentRows.filter(
          (r: Record<string, unknown>) => r.created_by !== 'system',
        );

        console.log(
          `  Agent definitions: ${String(agentRows.length)} rows (${String(systemRows.length)} system, ${String(nonSystemRows.length)} non-system)`,
        );
        for (const row of agentRows) {
          const flag = row.created_by !== 'system' ? ' ⚠ NON-SYSTEM' : '';
          console.log(
            `    - ${row.agent_id}@${row.version} (created_by: ${row.created_by})${flag}`,
          );
        }

        if (nonSystemRows.length > 0) {
          console.log(
            `    ⚠ WARNING: ${String(nonSystemRows.length)} row(s) have non-system created_by — these may be operator customizations.`,
          );
          if (execute) {
            console.log(`    ⚠ SKIPPING non-system rows. Only deleting system-created rows.`);
          }
        }

        totalAgentRows += systemRows.length;

        if (execute && systemRows.length > 0) {
          await sql`
            DELETE FROM agent_definitions
            WHERE agent_id = ANY(${platformAgentIds})
              AND created_by = 'system'
          `;
          console.log(`    ✓ Deleted ${String(systemRows.length)} system agent definition rows`);
        }
      } else {
        console.log(`  Agent definitions: clean`);
      }

      // Helper: audit and optionally soft-delete system-created memory docs.
      async function cleanupDocs(label: string, paths: string[]): Promise<number> {
        const docs = await sql`
          SELECT id, path, space_id, created_by_actor
          FROM memory_docs
          WHERE path = ANY(${paths})
            AND deleted_at IS NULL
        `;

        if (docs.length === 0) {
          console.log(`  ${label}: clean`);
          return 0;
        }

        const systemDocs = docs.filter(
          (d: Record<string, unknown>) => d.created_by_actor === 'system',
        );
        const nonSystemDocs = docs.filter(
          (d: Record<string, unknown>) => d.created_by_actor !== 'system',
        );

        console.log(
          `  ${label}: ${String(docs.length)} docs (${String(systemDocs.length)} system, ${String(nonSystemDocs.length)} non-system)`,
        );
        for (const doc of docs) {
          const flag = doc.created_by_actor !== 'system' ? ' ⚠ NON-SYSTEM' : '';
          console.log(
            `    - ${doc.path} (space: ${doc.space_id}, actor: ${doc.created_by_actor ?? 'unknown'})${flag}`,
          );
        }

        if (nonSystemDocs.length > 0) {
          console.log(
            `    ⚠ WARNING: ${String(nonSystemDocs.length)} doc(s) have non-system actor — skipping those.`,
          );
        }

        if (execute && systemDocs.length > 0) {
          await sql`
            UPDATE memory_docs
            SET deleted_at = NOW()
            WHERE path = ANY(${paths})
              AND deleted_at IS NULL
              AND created_by_actor = 'system'
          `;
          console.log(`    ✓ Soft-deleted ${String(systemDocs.length)} system docs`);
        }

        return systemDocs.length;
      }

      // 2. Check for seeded workflow memory docs
      const workflowPaths = platformWorkflowSlugs.map((s) => `/workflows/${s}/workflow.json`);
      totalWorkflowDocs += await cleanupDocs('Workflow docs', workflowPaths);

      // 3. Check for seeded skill manifest memory docs
      const manifestPaths = platformSkillIds.map((s) => `/skills/${s}/manifest.json`);
      totalManifestDocs += await cleanupDocs('Skill manifest docs', manifestPaths);

      // 4. Check for seeded eval suite memory docs
      const evalPaths = platformSkillIds.map((s) => `/evals/${s}/suite.json`);
      totalEvalDocs += await cleanupDocs('Eval suite docs', evalPaths);
    } finally {
      await sql.unsafe(`SET search_path TO public`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Agent definition rows: ${String(totalAgentRows)}`);
  console.log(`  Workflow docs:         ${String(totalWorkflowDocs)}`);
  console.log(`  Skill manifest docs:   ${String(totalManifestDocs)}`);
  console.log(`  Eval suite docs:       ${String(totalEvalDocs)}`);
  const total = totalAgentRows + totalWorkflowDocs + totalManifestDocs + totalEvalDocs;
  console.log(`  Total:                 ${String(total)}`);

  if (!execute && total > 0) {
    console.log(`\nRun with --execute to delete these artifacts.`);
  } else if (execute && total > 0) {
    console.log(`\n✓ All seeded platform artifacts cleaned up.`);
  } else {
    console.log(`\n✓ Nothing to clean up — all tenants are clean.`);
  }

  await closeConnection();
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
