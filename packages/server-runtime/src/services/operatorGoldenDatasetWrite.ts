import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { resolveWorkflowForStart } from '@aflow/database';
import type { GoldenCaseContent, GoldenCaseDiagnostic, TenantId } from '@aflow/schemas';
import {
  applyGoldenCaseWrite,
  materializeSkillTasks,
  validateGoldenCase,
  type GoldenCaseWriteAction,
} from '@aflow/cybernetic-runtime';

/**
 * Operator-authored golden-case writes (Plan 269 D7). The operator owns the
 * golden dataset — the ruler for the ruler — so writes apply immediately, but
 * only through this authenticated boundary: agents reach the dataset
 * read-only (`eval.dataset.*`) or via draft promotion, never through these
 * mutations. Case content is gated on chunk-A's authoring checks: an
 * undecidable case (error-severity diagnostics against the skill's current
 * materialized contract) is rejected with the typed diagnostics, never stored
 * active.
 */

export type OperatorGoldenCaseWriteResult =
  | {
      ok: true;
      datasetId: string;
      caseId: string;
      datasetVersion: number;
      revisionId?: string;
      advisories: GoldenCaseDiagnostic[];
    }
  | {
      ok: false;
      status: 404 | 409 | 422;
      code: string;
      detail: string;
      diagnostics?: GoldenCaseDiagnostic[];
    };

export async function applyOperatorGoldenCaseWrite(params: {
  tenantId: TenantId;
  spaceId: string;
  slug: string;
  action: GoldenCaseWriteAction;
  caseId?: string | undefined;
  content?: GoldenCaseContent | undefined;
  expectedDatasetVersion?: number | undefined;
  operatorUserId: string;
  db: PostgresJsDatabase;
}): Promise<OperatorGoldenCaseWriteResult> {
  const { tenantId, spaceId, slug, action, caseId, content, expectedDatasetVersion, db } = params;

  let advisories: GoldenCaseDiagnostic[] = [];
  if (action !== 'remove') {
    if (!content) {
      return { ok: false, status: 422, code: 'missing_case', detail: 'Case content is required.' };
    }
    const workflow = await resolveWorkflowForStart(db, tenantId, spaceId, slug);
    if (!workflow) {
      return {
        ok: false,
        status: 404,
        code: 'workflow_not_found',
        detail: `No skill '${slug}' exists in this space — a golden dataset measures an existing skill.`,
      };
    }
    const diagnostics = validateGoldenCase(content, {
      tasks: materializeSkillTasks(workflow.tasks),
    });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      return {
        ok: false,
        status: 422,
        code: 'undecidable_case',
        detail:
          'The case fails its authoring checks against the current skill revision — fix the diagnostics and retry.',
        diagnostics,
      };
    }
    advisories = diagnostics;
  }

  const result = await applyGoldenCaseWrite(db, tenantId, {
    spaceId,
    workflowSlug: slug,
    action,
    caseId,
    content,
    expectedDatasetVersion,
    createdByUserId: params.operatorUserId,
  });
  if (!result.ok) {
    const status =
      result.code === 'version_conflict' ? 409 : result.code === 'case_not_found' ? 404 : 409;
    return { ok: false, status, code: result.code, detail: result.detail };
  }
  return {
    ok: true,
    datasetId: result.datasetId,
    caseId: result.caseId,
    datasetVersion: result.datasetVersion,
    ...(result.revisionId !== undefined ? { revisionId: result.revisionId } : {}),
    advisories,
  };
}
