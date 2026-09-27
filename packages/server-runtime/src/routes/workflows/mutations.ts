/**
 * Workflow write routes — activation patch, dry-run validation, designer save.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  materializeAndValidateSkillConfig,
  renderSkillDiagnostics,
} from '@aflow/cybernetic-runtime';
import { WorkflowSchema, SkillValiditySchema } from '@aflow/schemas';
import {
  ErrorSchema,
  WorkflowSlugParamsSchema,
  spaceReadAuthz,
  spaceWriteAuthz,
  createWorkflowRepo,
  publishWorkflowUpdatedEvent,
} from './shared.js';

// Limits aligned with ProcedureActivationSchema (context.ts).
const ActivationPatchSchema = z.object({
  activationHint: z.string().max(500).optional(),
  triggerPatterns: z.array(z.string().max(200)).max(10).optional(),
  prerequisites: z.array(z.string().max(200)).max(5).optional(),
  iteration: z
    .object({
      auto: z.boolean().optional(),
      maxConsecutiveRuns: z.number().int().min(1).max(100).optional(),
      cooldownMs: z.number().int().nonnegative().optional(),
      stopOnOutcomesMet: z.boolean().optional(),
    })
    .optional(),
  budget: z
    .object({
      maxRuns: z.number().int().min(1).optional(),
      maxCostCents: z.number().int().min(1).optional(),
      maxDurationMs: z.number().int().min(1).optional(),
    })
    .optional(),
});

export function registerWorkflowMutationRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.patch(
    '/:spaceId/workflows/:slug/activation',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Update activation, iteration, and budget settings for a workflow',
        params: WorkflowSlugParamsSchema,
        body: ActivationPatchSchema,
        response: {
          200: z.object({ ok: z.boolean() }),
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const patch = request.body;

      const repo = createWorkflowRepo(fastify, tenant.tenantId);

      const doc = await repo.getByPath(`/workflows/${slug}/workflow.json`, spaceId);
      if (!doc || doc.deletedAt || doc.inlineContent === null) {
        return reply.status(404).send({ error: 'NotFound', message: `Workflow ${slug} not found` });
      }

      let wfRaw: Record<string, unknown>;
      try {
        wfRaw = JSON.parse(doc.inlineContent) as Record<string, unknown>;
      } catch {
        return reply
          .status(404)
          .send({ error: 'NotFound', message: `Workflow ${slug} content invalid` });
      }

      // Merge activation fields
      if (
        patch.activationHint !== undefined ||
        patch.triggerPatterns !== undefined ||
        patch.prerequisites !== undefined
      ) {
        const existing = (wfRaw['activation'] ?? {}) as Record<string, unknown>;
        if (patch.activationHint !== undefined) existing['activationHint'] = patch.activationHint;
        if (patch.triggerPatterns !== undefined)
          existing['triggerPatterns'] = patch.triggerPatterns;
        if (patch.prerequisites !== undefined) existing['prerequisites'] = patch.prerequisites;
        wfRaw['activation'] = existing;
      }

      // Merge iteration fields
      if (patch.iteration !== undefined) {
        const existing = (wfRaw['iteration'] ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch.iteration)) {
          if (v !== undefined) existing[k] = v;
        }
        wfRaw['iteration'] = existing;
      }

      // Merge budget fields
      if (patch.budget !== undefined) {
        const existing = (wfRaw['budget'] ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch.budget)) {
          if (v !== undefined) existing[k] = v;
        }
        wfRaw['budget'] = existing;
      }

      // Bump revision
      const prevRevision = typeof wfRaw['revision'] === 'number' ? wfRaw['revision'] : 0;
      wfRaw['revision'] = prevRevision + 1;

      // Validate the merged workflow against WorkflowSchema before persisting.
      // This prevents writing invalid JSON that would degrade/disappear from
      // the skills list (the list endpoint does safeParse and marks failures).
      const validation = WorkflowSchema.safeParse(wfRaw);
      if (!validation.success) {
        const firstIssue = validation.error.issues[0];
        const detail = firstIssue
          ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
          : validation.error.message;
        return reply.status(422).send({
          error: 'ValidationError',
          message: `Merged workflow fails validation: ${detail}`,
        });
      }

      const { materializedTasks, validity } = materializeAndValidateSkillConfig({
        tasks: validation.data.tasks,
        stateVariables: validation.data.stateVariables,
        output: validation.data.output,
        runInputs: validation.data.runInputs,
      });
      if (validity.status === 'invalid') {
        return reply.status(422).send({
          error: 'ValidationError',
          message: `Merged workflow fails contract validation:\n${renderSkillDiagnostics(validity.diagnostics)}`,
        });
      }
      wfRaw['tasks'] = materializedTasks;

      const content = JSON.stringify(wfRaw);
      await repo.put({
        path: `/workflows/${slug}/workflow.json`,
        docType: 'workflow',
        mimeType: 'application/json',
        inlineContent: content,
        payloadRef: null,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        contentHash: '',
        preview: null,
        tags: [],
        summary: null,
        scope: { spaceId },
        writeMode: 'overwrite',
        indexing: 'disabled',
      });

      await publishWorkflowUpdatedEvent(fastify, spaceId, slug);

      return { ok: true };
    },
  );

  // Dry-run contract validation for the Skill Designer. Runs the exact
  // validator the Save gate uses, without persisting. Accepts a candidate that
  // may not yet be schema-valid (mid-edit) and returns a uniform SkillValidity
  // combining parse + contract diagnostics.
  app.post(
    '/:spaceId/workflows/validate',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Validate a candidate workflow without persisting',
        params: z.object({ spaceId: z.string().uuid() }),
        body: z.object({ workflow: z.unknown() }),
        response: { 200: SkillValiditySchema },
      },
    },
    async (request) => {
      await request.requireTenant();
      const parsed = WorkflowSchema.safeParse((request.body as { workflow: unknown }).workflow);
      if (!parsed.success) {
        return {
          status: 'invalid' as const,
          diagnostics: parsed.error.issues.slice(0, 50).map((i) => ({
            code: `parse_${i.code}`,
            dimension: 'parse' as const,
            severity: 'error' as const,
            ...(i.path.length ? { field: i.path.join('.') } : {}),
            detail: i.message,
          })),
          advisories: [],
          validatedAt: new Date().toISOString(),
        };
      }
      const { validity } = materializeAndValidateSkillConfig({
        tasks: parsed.data.tasks,
        stateVariables: parsed.data.stateVariables,
        output: parsed.data.output,
        runInputs: parsed.data.runInputs,
      });
      return validity;
    },
  );

  // Operator Skill Designer save — replace a workflow definition wholesale.
  // Mirrors the activation patch's validate-before-persist discipline, adds
  // optimistic concurrency (baseRevision) and preserves server-authoritative
  // identity/provenance so the client cannot rewrite it.
  app.put(
    '/:spaceId/workflows/:slug',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Replace a workflow definition',
        params: WorkflowSlugParamsSchema,
        body: z.object({ workflow: WorkflowSchema, baseRevision: z.number().int().nonnegative() }),
        response: {
          200: z.object({
            ok: z.boolean(),
            revision: z.number().int(),
            contractValidity: SkillValiditySchema,
          }),
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const { workflow: posted, baseRevision } = request.body;

      const repo = createWorkflowRepo(fastify, tenant.tenantId);

      const doc = await repo.getByPath(`/workflows/${slug}/workflow.json`, spaceId);
      if (!doc || doc.deletedAt || doc.inlineContent === null) {
        return reply.status(404).send({ error: 'NotFound', message: `Workflow ${slug} not found` });
      }
      if (posted.slug !== slug) {
        return reply
          .status(422)
          .send({ error: 'ValidationError', message: 'Workflow slug does not match the URL' });
      }

      let existing: Record<string, unknown>;
      try {
        existing = JSON.parse(doc.inlineContent) as Record<string, unknown>;
      } catch {
        return reply
          .status(404)
          .send({ error: 'NotFound', message: `Workflow ${slug} content invalid` });
      }

      const existingRevision = typeof existing['revision'] === 'number' ? existing['revision'] : 0;
      if (existingRevision !== baseRevision) {
        return reply.status(409).send({
          error: 'Conflict',
          message: `Workflow changed since it was loaded (expected revision ${String(baseRevision)}, found ${String(existingRevision)}). Reload and re-apply your changes.`,
        });
      }

      // Preserve server-authoritative identity + provenance; the operator edits
      // the definition, never where it came from.
      const merged: Record<string, unknown> = {
        ...posted,
        id: existing['id'] ?? posted.id,
        slug,
        origin: existing['origin'] ?? posted.origin,
        createdAt: existing['createdAt'] ?? posted.createdAt,
        updatedAt: new Date().toISOString(),
        revision: existingRevision + 1,
      };
      if (existing['sourceCatalogId'] !== undefined) {
        merged['sourceCatalogId'] = existing['sourceCatalogId'];
      }

      const validation = WorkflowSchema.safeParse(merged);
      if (!validation.success) {
        const first = validation.error.issues[0];
        return reply.status(422).send({
          error: 'ValidationError',
          message: first ? `${first.path.join('.')}: ${first.message}` : validation.error.message,
        });
      }

      const { materializedTasks, validity } = materializeAndValidateSkillConfig({
        tasks: validation.data.tasks,
        stateVariables: validation.data.stateVariables,
        output: validation.data.output,
      });
      if (validity.status === 'invalid') {
        return reply.status(422).send({
          error: 'ValidationError',
          message: `Contract validation failed:\n${renderSkillDiagnostics(validity.diagnostics)}`,
        });
      }

      const finalDoc = { ...validation.data, tasks: materializedTasks };
      const content = JSON.stringify(finalDoc);
      await repo.put({
        path: `/workflows/${slug}/workflow.json`,
        docType: 'workflow',
        mimeType: 'application/json',
        inlineContent: content,
        payloadRef: null,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        contentHash: '',
        preview: null,
        tags: [],
        summary: null,
        scope: { spaceId },
        writeMode: 'overwrite',
        indexing: 'disabled',
      });

      await publishWorkflowUpdatedEvent(fastify, spaceId, slug);

      return { ok: true, revision: existingRevision + 1, contractValidity: validity };
    },
  );
}
