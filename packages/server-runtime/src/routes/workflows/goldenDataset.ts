/**
 * Operator-only golden-dataset writes (Plan 269 D7). The D7 authority split
 * is enforced at this boundary, not narrated: these routes exist ONLY as
 * authenticated server REST — they are not registry operations, appear in no
 * agent preset, and reject service-principal (agent) callers outright. Case
 * add/update/remove each create an immutable revision and bump the dataset
 * version (ratifying a draft promotion IS the update path); label submission
 * stamps `labeledBy` from the authenticated principal.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { evalLabels } from '@aflow/database';
import {
  EvalCaseRubricResultSchema,
  EvalLabelVerdictSchema,
  GoldenCaseContentSchema,
  GoldenCaseDiagnosticSchema,
  GoldenCaseRevisionSchema,
  GoldenDatasetSchema,
  type GoldenCaseDiagnostic,
} from '@aflow/schemas';
import {
  getEvalBatchById,
  getTrialRow,
  loadGoldenDatasetBundle,
  resolveLabelQueueItemForSubject,
} from '@aflow/cybernetic-runtime';
import {
  WorkflowSlugParamsSchema,
  spaceReadAuthz,
  spaceWriteAuthz,
  getDb,
  ErrorSchema,
} from './shared.js';
import { requireOperatorPrincipal } from '../../lib/operatorPrincipal.js';
import { applyOperatorGoldenCaseWrite } from '../../services/operatorGoldenDatasetWrite.js';
import { insertEvalLabelRow } from '../../services/evalLabelWrite.js';

const CaseParamsSchema = WorkflowSlugParamsSchema.extend({
  caseId: z.string().uuid(),
});

const CaseWriteBodySchema = z.object({
  case: GoldenCaseContentSchema,
  /** Optimistic-concurrency precondition: 409 when the dataset moved. */
  expectedDatasetVersion: z.number().int().nonnegative().optional(),
});

const CaseWriteOkSchema = z.object({
  ok: z.literal(true),
  datasetId: z.string(),
  caseId: z.string(),
  datasetVersion: z.number(),
  revisionId: z.string().optional(),
  advisories: z.array(GoldenCaseDiagnosticSchema),
});

const CaseWriteErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  diagnostics: z.array(GoldenCaseDiagnosticSchema).optional(),
});

export function registerGoldenDatasetRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/workflows/:slug/golden-dataset',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'The skill’s golden dataset — active cases at the resolved version plus open drafts',
        params: WorkflowSlugParamsSchema,
        querystring: z.object({
          version: z.coerce.number().int().nonnegative().optional(),
        }),
        response: {
          200: z.object({
            /** Null when no dataset exists yet — the Measurement tab teaches the loop instead of erroring. */
            dataset: GoldenDatasetSchema.nullable(),
            resolvedVersion: z.number().int().nonnegative().optional(),
            cases: z.array(GoldenCaseRevisionSchema),
            drafts: z.array(GoldenCaseRevisionSchema),
            /**
             * Rows live at this version that do not parse. They are absent
             * from `cases` and they refuse a launch, so a listing that omitted
             * them left the operator unable to reach the thing blocking them.
             */
            unreadable: z.array(
              z.object({
                revisionId: z.string(),
                caseId: z.string(),
                title: z.string(),
                reason: z.string(),
              }),
            ),
          }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const loaded = await loadGoldenDatasetBundle(getDb(fastify), tenant.tenantId, {
        spaceId: space.spaceId,
        workflowSlug: request.params.slug,
        version: request.query.version,
      });
      if (!loaded.ok) {
        if (loaded.code === 'version_not_found') {
          return reply.status(404).send({
            error: 'dataset_version_not_found',
            message: `Dataset version ${String(request.query.version)} does not exist — the dataset is at version ${String(loaded.currentVersion)}.`,
          });
        }
        return reply.send({ dataset: null, cases: [], drafts: [], unreadable: [] });
      }
      const { bundle } = loaded;
      return reply.send({
        dataset: bundle.dataset,
        resolvedVersion: bundle.resolvedVersion,
        unreadable: bundle.unreadable.map((row) => ({
          revisionId: row.revisionId,
          caseId: row.caseId,
          title: row.title,
          reason: row.reason,
        })),
        cases: bundle.cases,
        drafts: bundle.drafts,
      });
    },
  );

  app.post(
    '/:spaceId/workflows/:slug/golden-cases',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Add a golden case (operator-only; bumps datasetVersion)',
        params: WorkflowSlugParamsSchema,
        body: CaseWriteBodySchema,
        response: {
          200: CaseWriteOkSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: CaseWriteErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;
      const result = await applyOperatorGoldenCaseWrite({
        tenantId: tenant.tenantId,
        spaceId: space.spaceId,
        slug: request.params.slug,
        action: 'add',
        content: request.body.case,
        expectedDatasetVersion: request.body.expectedDatasetVersion,
        operatorUserId: operator.userId,
        db: getDb(fastify),
      });
      if (!result.ok) {
        return reply.status(result.status).send({
          error: result.code,
          message: result.detail,
          ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        });
      }
      return reply.send(caseWriteOk(result));
    },
  );

  app.put(
    '/:spaceId/workflows/:slug/golden-cases/:caseId',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'Update a golden case (operator-only; ratifying a draft promotion is this same draft→active path)',
        params: CaseParamsSchema,
        body: CaseWriteBodySchema,
        response: {
          200: CaseWriteOkSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: CaseWriteErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;
      const result = await applyOperatorGoldenCaseWrite({
        tenantId: tenant.tenantId,
        spaceId: space.spaceId,
        slug: request.params.slug,
        action: 'update',
        caseId: request.params.caseId,
        content: request.body.case,
        expectedDatasetVersion: request.body.expectedDatasetVersion,
        operatorUserId: operator.userId,
        db: getDb(fastify),
      });
      if (!result.ok) {
        return reply.status(result.status).send({
          error: result.code,
          message: result.detail,
          ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        });
      }
      return reply.send(caseWriteOk(result));
    },
  );

  app.delete(
    '/:spaceId/workflows/:slug/golden-cases/:caseId',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Remove a golden case (operator-only; discarding a draft bumps nothing)',
        params: CaseParamsSchema,
        querystring: z.object({
          expectedDatasetVersion: z.coerce.number().int().nonnegative().optional(),
        }),
        response: {
          200: z.object({ ok: z.literal(true), datasetVersion: z.number() }),
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;
      const result = await applyOperatorGoldenCaseWrite({
        tenantId: tenant.tenantId,
        spaceId: space.spaceId,
        slug: request.params.slug,
        action: 'remove',
        caseId: request.params.caseId,
        expectedDatasetVersion: request.query.expectedDatasetVersion,
        operatorUserId: operator.userId,
        db: getDb(fastify),
      });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.code, message: result.detail });
      }
      return reply.send({ ok: true as const, datasetVersion: result.datasetVersion });
    },
  );

  app.post(
    '/:spaceId/workflows/:slug/eval-labels',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Record a human eval label (operator-only; labeledBy server-stamped)',
        params: WorkflowSlugParamsSchema,
        body: z
          .object({
            runId: z.string().min(1).max(256),
            /** Case-scoped labels tie the verdict to the batch trial they judge. */
            caseRevisionId: z.string().uuid().optional(),
            batchId: z.string().uuid().optional(),
            trial: z.number().int().nonnegative().optional(),
            criterionId: z.string().min(1).max(200),
            scopeKey: z.string().min(1).max(300),
            verdict: EvalLabelVerdictSchema,
            critique: z.string().min(1).max(8000),
            evalSuitePath: z.string().min(1).max(512).optional(),
            judgeVersion: z.string().min(1).max(128).optional(),
          })
          .refine(
            (body) =>
              (body.caseRevisionId === undefined) === (body.batchId === undefined) &&
              (body.caseRevisionId === undefined) === (body.trial === undefined),
            {
              message:
                'A case-scoped label subject is (batchId, caseRevisionId, trial) — supply all three, or none for a run-scoped label.',
            },
          ),
        response: {
          201: z.object({ id: z.string().uuid() }),
          403: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;
      const body = request.body;
      // The judge's own verdict is read from the stored grading record, never
      // taken from the caller: agreement is only a measurement if both sides
      // of it are facts. A case-scoped label finds it on the trial row.
      const judged =
        body.batchId !== undefined && body.caseRevisionId !== undefined && body.trial !== undefined
          ? await readJudgedSlot(getDb(fastify), tenant.tenantId, {
              spaceId: space.spaceId,
              workflowSlug: request.params.slug,
              batchId: body.batchId,
              caseRevisionId: body.caseRevisionId,
              trial: body.trial,
              runId: body.runId,
              criterionId: body.criterionId,
              scopeKey: body.scopeKey,
            })
          : null;
      const vals: typeof evalLabels.$inferInsert = {
        spaceId: space.spaceId,
        runId: body.runId,
        caseRevisionId: body.caseRevisionId ?? null,
        batchId: body.batchId ?? null,
        trial: body.trial ?? null,
        // A label filed against a suite that cannot be named is invisible to
        // every per-criterion read, which all scope by suite path.
        evalSuitePath: body.evalSuitePath ?? `/evals/${request.params.slug}/suite.json`,
        ...(judged !== null
          ? { judgeLabel: judged.verdict, judgeScore: String(judged.score) }
          : {}),
        // The stored slot's judge wins over anything the caller named: a
        // verdict filed under a judge that never produced it is worse than no
        // provenance at all, because a scorecard would count it.
        judgeVersion: judged?.judgeVersion ?? body.judgeVersion ?? null,
        criterionId: body.criterionId,
        scopeKey: body.scopeKey,
        verdict: body.verdict,
        critique: body.critique,
        // Every label this route mints arrived through an operator-picked
        // stream — an enriched sample, never scorecard material (D10).
        // 'validation' is minted ONLY by the batch engine's uniform random
        // slice, stamped from the queue item; no caller-declared partition.
        partition: 'exemplar',
        labeledByUserId: operator.userId,
      };
      const result = await insertEvalLabelRow(getDb(fastify), tenant.tenantId, vals);
      if (!result.ok) {
        return reply.status(409).send({
          error: 'label_exists',
          message: `A label already exists for criterion "${body.criterionId}" on this subject.`,
        });
      }
      // A judged failure already has a pending queue item for this same
      // subject, and the two share an identity — so the bench's own submit
      // would collide with what was just filed and strand the row. Clearing it
      // here is what keeps the queue answerable.
      if (
        body.batchId !== undefined &&
        body.caseRevisionId !== undefined &&
        body.trial !== undefined
      ) {
        await resolveLabelQueueItemForSubject(getDb(fastify), tenant.tenantId, {
          spaceId: space.spaceId,
          batchId: body.batchId,
          caseRevisionId: body.caseRevisionId,
          trial: body.trial,
          criterionId: body.criterionId,
          scopeKey: body.scopeKey,
          partition: 'exemplar',
          labelId: result.id,
        });
      }
      return reply.status(201).send({ id: result.id });
    },
  );
}

/**
 * The judge's recorded verdict for one rubric slot of one trial, or null when
 * the trial, its grading record or that slot is not there — a label still
 * records the operator's verdict when the judge's cannot be found.
 *
 * The batch is resolved against the authorized space and workflow FIRST. The
 * ids arrive in the request body and a trial read is tenant-scoped, so without
 * that check a caller could name another space's batch and have its judge facts
 * copied into a label filed here — authorization would have passed, because it
 * was asked about the route's space and never about the batch.
 */
async function readJudgedSlot(
  db: Parameters<typeof getTrialRow>[0],
  tenantId: Parameters<typeof getTrialRow>[1],
  params: {
    spaceId: string;
    workflowSlug: string;
    batchId: string;
    caseRevisionId: string;
    trial: number;
    runId: string;
    criterionId: string;
    scopeKey: string;
  },
): Promise<{ verdict: string; score: number; judgeVersion: string | undefined } | null> {
  const head = await getEvalBatchById(db, tenantId, params.batchId);
  if (head === null) return null;
  if (head.spaceId !== params.spaceId || head.workflowSlug !== params.workflowSlug) return null;
  const row = await getTrialRow(db, tenantId, params);
  if (row === null) return null;
  // The run is named separately from the trial that produced it, so a label
  // could otherwise carry one run's id beside another run's judge verdict —
  // and a row that never started has no judge to attach at all.
  if (row.runId === null || row.runId !== params.runId) return null;
  // Only the rubric slots are read, not the whole grading record: a record
  // that fails to parse in some unrelated field still knows what the judge
  // returned here, and losing that would silently make the label unmeasurable.
  const slots = z
    .object({ rubricResults: z.array(EvalCaseRubricResultSchema).catch([]) })
    .safeParse(row.resultsJson);
  if (!slots.success) return null;
  const slot = slots.data.rubricResults.find(
    (entry) =>
      entry.criterionId === params.criterionId &&
      entry.scopeKey === params.scopeKey &&
      entry.status === 'judged',
  );
  // `judgeVersion` comes from the slot too. Taking it from the caller would let
  // a real verdict be filed under an arbitrary judge, and a scorecard keyed by
  // judge version would then attribute it to one that never ran.
  return slot?.status === 'judged'
    ? { verdict: slot.verdict, score: slot.score, judgeVersion: slot.judgeVersion }
    : null;
}

function caseWriteOk(result: {
  datasetId: string;
  caseId: string;
  datasetVersion: number;
  revisionId?: string;
  advisories: GoldenCaseDiagnostic[];
}): z.infer<typeof CaseWriteOkSchema> {
  return {
    ok: true,
    datasetId: result.datasetId,
    caseId: result.caseId,
    datasetVersion: result.datasetVersion,
    ...(result.revisionId !== undefined ? { revisionId: result.revisionId } : {}),
    advisories: result.advisories,
  };
}
