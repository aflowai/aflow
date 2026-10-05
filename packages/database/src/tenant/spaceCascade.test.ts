import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { eq } from 'drizzle-orm';
import { SimulationSchema, type TenantId } from '@aflow/schemas';
import { createDatabase } from '../connection.js';
import { createTenantContext } from './context.js';
import { withTenantSchema } from './queries.js';
import {
  spaces,
  campaigns,
  planNodes,
  planNodeLinks,
  coachCandidateLearnings,
  coachLearnings,
  repoBindings,
  storeInstalls,
  storeInstallArtifacts,
  storeInstallClaims,
  oauthClients,
  simulations,
  simulationBaselines,
  simulationEntities,
  simulationCallRecords,
  simulationRunContexts,
} from '../schema/tenant.js';
import { spaceGrants, users } from '../schema/public.js';
import { cascadeDeleteSpace, previewCascadeForSpace } from './spaceCascade.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

// Sentinel space id per the sandbox convention (bb5a0000 prefix) — never a
// real operator space, always cleaned up.
const SPACE_ID = 'bb5a0000-0000-4000-8000-000000000001';
// space_grants.granted_by is a real FK to public.users — a dedicated sentinel
// row so the test never depends on which users happen to exist locally.
const GRANTOR_USER_ID = 'bb5a0000-0000-4000-8000-0000000000f1';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb(
  'cascadeDeleteSpace / previewCascadeForSpace — direct space_id table coverage (real DB)',
  () => {
    const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
    const sql = handle.sql;
    const db = handle.db;
    const tenantCtx = createTenantContext(TENANT_ID as TenantId);

    let schemaReady = false;

    async function cleanup(): Promise<void> {
      await withTenantSchema(db, tenantCtx, async (tx) => {
        await tx.delete(campaigns).where(eq(campaigns.spaceId, SPACE_ID));
        await tx.delete(planNodeLinks).where(eq(planNodeLinks.spaceId, SPACE_ID));
        await tx.delete(planNodes).where(eq(planNodes.spaceId, SPACE_ID));
        await tx
          .delete(coachCandidateLearnings)
          .where(eq(coachCandidateLearnings.spaceId, SPACE_ID));
        await tx.delete(coachLearnings).where(eq(coachLearnings.spaceId, SPACE_ID));
        await tx.delete(repoBindings).where(eq(repoBindings.spaceId, SPACE_ID));
        await tx.delete(storeInstalls).where(eq(storeInstalls.spaceId, SPACE_ID));
        await tx.delete(storeInstallArtifacts).where(eq(storeInstallArtifacts.spaceId, SPACE_ID));
        await tx.delete(storeInstallClaims).where(eq(storeInstallClaims.spaceId, SPACE_ID));
        await tx.delete(oauthClients).where(eq(oauthClients.scopeId, SPACE_ID));
        await tx.delete(simulationCallRecords).where(eq(simulationCallRecords.spaceId, SPACE_ID));
        await tx.delete(simulationRunContexts).where(eq(simulationRunContexts.spaceId, SPACE_ID));
        await tx.delete(simulationEntities).where(eq(simulationEntities.spaceId, SPACE_ID));
        await tx.delete(simulationBaselines).where(eq(simulationBaselines.spaceId, SPACE_ID));
        await tx.delete(simulations).where(eq(simulations.spaceId, SPACE_ID));
        await tx.delete(spaces).where(eq(spaces.id, SPACE_ID));
      });
      await db.delete(spaceGrants).where(eq(spaceGrants.spaceId, SPACE_ID));
      await db.delete(users).where(eq(users.id, GRANTOR_USER_ID));
    }

    beforeAll(async () => {
      const rows = await sql<{ ok: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'plan_node_links'
        ) AS ok`;
      schemaReady = rows[0]?.ok === true;
      if (!schemaReady) return;

      await cleanup();
      await db.insert(users).values({
        id: GRANTOR_USER_ID,
        displayName: 'Cascade Coverage Sentinel Grantor',
      });
      await withTenantSchema(db, tenantCtx, async (tx) => {
        await tx.insert(spaces).values({
          id: SPACE_ID,
          name: 'Cascade Coverage Sentinel Space',
          slug: `cascade-coverage-${randomUUID().slice(0, 8)}`,
        });

        const runId = `run-${randomUUID()}`;
        await tx.insert(campaigns).values({
          spaceId: SPACE_ID,
          workflowSlug: 'sentinel-workflow',
          goalRef: 'goal:sentinel',
          scoreMetricKey: 'score',
          direction: 'maximize',
        });
        const [node] = await tx
          .insert(planNodes)
          .values({
            spaceId: SPACE_ID,
            kind: 'execute',
            title: 'Sentinel node',
            goal: 'sentinel goal',
            criteria: 'sentinel criteria',
          })
          .returning({ id: planNodes.id });
        await tx.insert(planNodeLinks).values({
          nodeId: node!.id,
          spaceId: SPACE_ID,
          kind: 'pull_request',
          ref: 'https://example.invalid/sentinel/pull/1',
        });
        await tx.insert(coachCandidateLearnings).values({
          spaceId: SPACE_ID,
          skillSlug: 'sentinel-skill',
          runId,
          learningId: `learning-${randomUUID()}`,
          learningJson: { statement: 'sentinel' },
        });
        await tx.insert(coachLearnings).values({
          id: randomUUID(),
          coachSessionId: randomUUID(),
          spaceId: SPACE_ID,
          scopeKind: 'space',
          kind: 'sentinel',
          statement: 'sentinel learning',
          evidence: {},
          confidence: 'medium',
          authorityLevel: 'auto_record',
        });
        await tx.insert(repoBindings).values({
          repoDesignationId: `repo-${randomUUID()}`,
          spaceId: SPACE_ID,
          coordinate: 'example.invalid/sentinel/repo',
          defaultBranch: 'main',
          connectionBindingId: `conn-${randomUUID()}`,
          createdBy: randomUUID(),
        });
        await tx.insert(storeInstalls).values({
          catalogId: `catalog-${randomUUID()}`,
          spaceId: SPACE_ID,
          kind: 'skill',
          installedVersion: 1,
          installedContentHash: 'sentinel-hash',
          installedBy: randomUUID(),
          updatedBy: randomUUID(),
        });
        await tx.insert(storeInstallArtifacts).values({
          catalogId: `catalog-${randomUUID()}`,
          spaceId: SPACE_ID,
          artifactType: 'skill',
          artifactKey: 'sentinel-key',
          artifactId: 'sentinel-artifact',
          installedContentHash: 'sentinel-hash',
          preservation: 'replace_on_update',
        });
        await tx.insert(storeInstallClaims).values({
          catalogId: `catalog-${randomUUID()}`,
          spaceId: SPACE_ID,
          claimedBy: 'direct',
        });
        await tx.insert(oauthClients).values({
          scope: 'space',
          scopeId: SPACE_ID,
          issuerKey: 'sentinel-issuer',
          clientId: 'sentinel-client',
          encryptedClientSecret: 'sentinel-encrypted-secret',
          label: 'Sentinel OAuth client',
          createdBy: randomUUID(),
        });

        const simulationId = `sim-${randomUUID()}`;
        await tx.insert(simulations).values({
          simulationId,
          spaceId: SPACE_ID,
          name: 'Sentinel Simulation',
          targetApiId: 'sentinel-api',
          definitionJson: SimulationSchema.parse({
            simulationId,
            name: 'Sentinel Simulation',
            targets: { sourceKind: 'api', integrationId: 'sentinel-api' },
          }),
        });
        await tx.insert(simulationBaselines).values({
          simulationId,
          spaceId: SPACE_ID,
          version: 1,
        });
        await tx.insert(simulationEntities).values({
          spaceId: SPACE_ID,
          simulationId,
          version: 1,
          collection: 'customers',
          entityId: 'sentinel-customer',
          bodyJson: { id: 'sentinel-customer' },
        });
        await tx.insert(simulationCallRecords).values({
          spaceId: SPACE_ID,
          runId,
          logicalExecutionId: `logical-${randomUUID()}`,
          simulationId,
          bindingId: 'sentinel-binding',
          apiId: 'sentinel-api',
          endpointId: 'getCustomer',
          requestJson: { method: 'GET', url: 'https://simulated.invalid/sentinel-api/customers/1' },
          matchedJson: { rung: 'contract_example' },
          responseStatus: 200,
          responseRef: 'inline:e30=',
          ordinal: 0,
          worldVersionBefore: 0,
          worldVersionAfter: 0,
          clockMs: 0,
        });
        await tx.insert(simulationRunContexts).values({
          spaceId: SPACE_ID,
          runId,
          simulationId,
          contextJson: {
            simulationId,
            simulationRevision: 1,
            baselineVersion: 1,
            snapshotRef: 'inline:e30=',
            definitionHash: 'sentinel-hash',
            seed: 'sentinel-seed',
            clockAnchorMs: 0,
          },
          snapshotRef: 'inline:e30=',
        });
      });
      await db.insert(spaceGrants).values({
        tenantId: TENANT_ID,
        spaceId: SPACE_ID,
        email: 'sentinel-grantee@example.invalid',
        grantedBy: GRANTOR_USER_ID,
      });
    });

    afterAll(async () => {
      if (schemaReady) await cleanup();
      await handle.close();
    });

    it('preview and delete cover the same set of tables — no drift between the two mirrors', async (ctx: TestContext) => {
      if (!schemaReady) {
        ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
        return;
      }

      const preview = await previewCascadeForSpace(sql, TENANT_SCHEMA, SPACE_ID);
      const newTables = [
        'campaigns',
        'plan_node_links',
        'plan_nodes',
        'coach_candidate_learnings',
        'coach_learnings',
        'repo_bindings',
        'store_installs',
        'store_install_artifacts',
        'store_install_claims',
        'oauth_clients',
        'simulations',
        'simulation_baselines',
        'simulation_entities',
        'simulation_call_records',
        'simulation_run_contexts',
        'public.space_grants',
      ];
      for (const table of newTables) {
        expect(preview[table]).toBe(1);
      }

      const counts = await sql.begin(async (txHandle) => {
        const tx = txHandle as unknown as typeof sql;
        return cascadeDeleteSpace(tx, TENANT_SCHEMA, SPACE_ID);
      });

      // The delete's per-table counts must match the preview's exactly for
      // every label the preview reported — a mismatch means the two
      // functions drifted and the operator's blast-radius preview lied.
      for (const [label, count] of Object.entries(preview)) {
        expect(counts[label]).toBe(count);
      }

      // The reverse direction: a table the delete touched but the preview
      // never counted (public.space_grants' original bug — deleted, never
      // previewed) undercounts the blast radius the operator confirms against.
      for (const label of Object.keys(counts)) {
        expect(preview).toHaveProperty(label);
      }

      // Rows are actually gone.
      const rows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM ${sql(TENANT_SCHEMA)}.campaigns WHERE space_id = ${SPACE_ID}`;
      expect(rows[0]?.c).toBe(0);
      const oauthRows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM ${sql(TENANT_SCHEMA)}.oauth_clients WHERE scope_id = ${SPACE_ID}`;
      expect(oauthRows[0]?.c).toBe(0);
      const grantRows = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM public.space_grants WHERE space_id = ${SPACE_ID}`;
      expect(grantRows[0]?.c).toBe(0);
    });
  },
);
