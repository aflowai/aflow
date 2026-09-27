import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createMemoryDocRepository,
  createMemoryDirRepository,
  createTenantContext,
  workflowDocPath,
} from '@aflow/database';
import type { SkillComposeBundle, StagedChange, TenantId } from '@aflow/schemas';
import {
  ComposedManifestSchema,
  ComposedWorkflowSchema,
  ProcedureActivationSchema,
  SkillComposeBundleSchema,
  StagedChangeSchema,
  slugify,
} from '@aflow/schemas';
import { applyRatifiedOps } from '@aflow/cybernetic-runtime';

/**
 * Operator-authored skill creation. The operator IS the authority, so the new
 * skill applies immediately — but through the SAME create authority the agent
 * uses (`applyRatifiedOps` → `applySkillComposeBundle`), as a ratified
 * `skill_compose` change tagged `source: 'operator'`. Never a manifest write
 * of its own. A pure template/designer create has no authoring skill, so the op
 * carries an explicit operator author sentinel rather than spoofing a composer.
 *
 * v1 scope: process / project archetypes — a minimal valid starter (one agent
 * task + one manual outcome) the operator fleshes out in the designer.
 * Optimization create needs a bound campaign contract + numeric goal + loop
 * wiring, so it lands later with the contract editor.
 */

const STAGED_DIR = '/coach/staged';
const TTL_MS = 365 * 24 * 60 * 60 * 1000;
const NOT_A_COACH_SESSION = '00000000-0000-0000-0000-000000000000';
/** Audit-only authorship marker for a no-agent operator create. */
const OPERATOR_AUTHOR = 'operator';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export type SkillArchetype = 'process' | 'project';

export type OperatorSkillCreateResult =
  { ok: true; slug: string } | { ok: false; status: 409 | 422; code: string; detail: string };

export interface OperatorSkillCreateParams {
  tenantId: TenantId;
  spaceId: string;
  name: string;
  goal: string;
  archetype: SkillArchetype;
  operatorUserId: string;
  db: PostgresJsDatabase;
}

export async function createOperatorSkill(
  params: OperatorSkillCreateParams,
): Promise<OperatorSkillCreateResult> {
  const { tenantId, spaceId, name, goal, archetype, operatorUserId, db } = params;

  const slug = slugify(name);
  if (slug.length < 3 || slug.length > 64 || !SLUG_RE.test(slug)) {
    return {
      ok: false,
      status: 422,
      code: 'invalid_slug',
      detail: `"${name}" does not produce a valid skill slug — use at least 3 alphanumeric characters.`,
    };
  }

  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  // Deterministic slug-taken signal: an active workflow at this slug means the
  // skill exists (an archived one is revivable, so it doesn't block). The apply
  // re-checks this; pre-checking lets us return a clean 409 rather than reading
  // the create-only guard's prose out of the apply error.
  const existing = await docRepo.getByPath(workflowDocPath(slug), spaceId);
  if (existing) {
    return {
      ok: false,
      status: 409,
      code: 'slug_taken',
      detail: `A skill named "${name}" (slug "${slug}") already exists. Open it to edit, or pick a different name.`,
    };
  }

  const bundleParse = SkillComposeBundleSchema.safeParse(
    buildStarterBundle(slug, name, goal, archetype),
  );
  if (!bundleParse.success) {
    return { ok: false, status: 422, code: 'invalid_bundle', detail: bundleParse.error.message };
  }

  const stagedParse = StagedChangeSchema.safeParse(
    buildRatifiedComposeChange(slug, name, goal, archetype, bundleParse.data, operatorUserId),
  );
  if (!stagedParse.success) {
    return {
      ok: false,
      status: 422,
      code: 'invalid_staged_change',
      detail: stagedParse.error.message,
    };
  }
  const stagedChange: StagedChange = stagedParse.data;

  try {
    await applyRatifiedOps({ tenantId, spaceId, db }, stagedChange);
  } catch (err) {
    return { ok: false, status: 422, code: 'apply_failed', detail: errText(err) };
  }

  await persistStagedAuditDoc(docRepo, dirRepo, spaceId, stagedChange, operatorUserId, name);

  return { ok: true, slug };
}

export type OperatorSkillCloneResult =
  { ok: true; slug: string } | { ok: false; status: 404 | 409 | 422; code: string; detail: string };

export interface OperatorSkillCloneParams {
  tenantId: TenantId;
  spaceId: string;
  sourceSlug: string;
  name: string;
  operatorUserId: string;
  db: PostgresJsDatabase;
}

/**
 * Clone an existing skill under a new name, through the same ratified
 * `skill_compose` authority as create. The clone copies the definition
 * (workflow, manifest with its campaign contract, activation) and nothing
 * else — the ledger, campaigns, run history, eval suite (the Coach re-authors
 * evals per skill), and store provenance stay with the source, so the clone
 * is a plain space-authored skill.
 */
export async function cloneOperatorSkill(
  params: OperatorSkillCloneParams,
): Promise<OperatorSkillCloneResult> {
  const { tenantId, spaceId, sourceSlug, name, operatorUserId, db } = params;

  const slug = slugify(name);
  if (slug.length < 3 || slug.length > 64 || !SLUG_RE.test(slug)) {
    return {
      ok: false,
      status: 422,
      code: 'invalid_slug',
      detail: `"${name}" does not produce a valid skill slug — use at least 3 alphanumeric characters.`,
    };
  }

  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  const sourceDoc = await docRepo.getByPath(workflowDocPath(sourceSlug), spaceId);
  if (!sourceDoc || sourceDoc.deletedAt || !sourceDoc.inlineContent) {
    return {
      ok: false,
      status: 404,
      code: 'source_not_found',
      detail: `Skill "${sourceSlug}" not found in this space.`,
    };
  }
  let sourceWorkflow: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(sourceDoc.inlineContent);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    sourceWorkflow = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      status: 422,
      code: 'source_invalid',
      detail: `Skill "${sourceSlug}" has an unreadable definition and cannot be cloned.`,
    };
  }

  const existing = await docRepo.getByPath(workflowDocPath(slug), spaceId);
  if (existing) {
    return {
      ok: false,
      status: 409,
      code: 'slug_taken',
      detail: `A skill named "${name}" (slug "${slug}") already exists. Pick a different name.`,
    };
  }

  const manifestDoc = await docRepo.getByPath(`/skills/${sourceSlug}/manifest.json`, spaceId);
  const sourceManifest = parseJsonObject(manifestDoc?.inlineContent ?? null);
  const activationDoc = await docRepo.getByPath(
    `/workflows/${sourceSlug}/activation.json`,
    spaceId,
  );
  const sourceActivation = parseJsonObject(activationDoc?.inlineContent ?? null);

  const sourceName =
    typeof sourceWorkflow['name'] === 'string' ? sourceWorkflow['name'] : sourceSlug;

  const bundleParse = SkillComposeBundleSchema.safeParse(
    buildCloneBundle({
      slug,
      name,
      sourceSlug,
      sourceName,
      sourceWorkflow,
      sourceManifest,
      sourceActivation,
    }),
  );
  if (!bundleParse.success) {
    return { ok: false, status: 422, code: 'invalid_bundle', detail: bundleParse.error.message };
  }

  const stagedParse = StagedChangeSchema.safeParse(
    buildOperatorRatifiedChange({
      slug,
      summary: `Clone skill: ${name}`,
      rationale: `Operator cloned "${sourceName}" (${sourceSlug}).`,
      bundle: bundleParse.data,
      operatorUserId,
    }),
  );
  if (!stagedParse.success) {
    return {
      ok: false,
      status: 422,
      code: 'invalid_staged_change',
      detail: stagedParse.error.message,
    };
  }
  const stagedChange: StagedChange = stagedParse.data;

  try {
    await applyRatifiedOps({ tenantId, spaceId, db }, stagedChange);
  } catch (err) {
    return { ok: false, status: 422, code: 'apply_failed', detail: errText(err) };
  }

  await persistStagedAuditDoc(docRepo, dirRepo, spaceId, stagedChange, operatorUserId, name);

  return { ok: true, slug };
}

/**
 * Build the compose bundle for a clone from the source skill's persisted docs.
 * Field lists derive from the compose schemas (identity fields excluded), so a
 * schema addition is cloned without touching this code.
 */
export function buildCloneBundle(args: {
  slug: string;
  name: string;
  sourceSlug: string;
  sourceName: string;
  sourceWorkflow: Record<string, unknown>;
  sourceManifest: Record<string, unknown> | null;
  sourceActivation: Record<string, unknown> | null;
}): Record<string, unknown> {
  const workflow: Record<string, unknown> = { slug: args.slug, name: args.name };
  for (const key of Object.keys(ComposedWorkflowSchema.shape)) {
    if (key === 'slug' || key === 'name') continue;
    const value = args.sourceWorkflow[key];
    if (value !== undefined) workflow[key] = value;
  }

  const manifest: Record<string, unknown> = { skillId: args.slug, name: args.name };
  const manifestSource = args.sourceManifest ?? {};
  for (const key of Object.keys(ComposedManifestSchema.shape)) {
    if (key === 'skillId' || key === 'name') continue;
    const value = manifestSource[key];
    if (value !== undefined) manifest[key] = value;
  }
  // A missing manifest doc degrades to workflow-derived fields (goal accepts a
  // plain string; the schema lifts it to a subjective rubric).
  if (manifest['goal'] === undefined) {
    manifest['goal'] = args.sourceWorkflow['goal'] ?? `Cloned from "${args.sourceName}".`;
  }
  if (manifest['mode'] === undefined) manifest['mode'] = args.sourceWorkflow['mode'];

  const bundle: Record<string, unknown> = {
    workflow,
    manifest,
    rationale: `Cloned from "${args.sourceName}" (${args.sourceSlug}).`,
  };

  // Activation is a nicety; a stale/invalid activation doc must not block the
  // clone, so it is included only when it parses.
  const activation = ProcedureActivationSchema.safeParse(args.sourceActivation);
  if (args.sourceActivation !== null && activation.success) {
    bundle['activation'] = activation.data;
  }
  return bundle;
}

function parseJsonObject(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The ratified doc is a best-effort audit trail — a failure persisting it must
 * not surface as a failed create (which would leave the operator staring at an
 * error for a skill that was created, and a retry hitting the slug conflict).
 */
async function persistStagedAuditDoc(
  docRepo: ReturnType<typeof createMemoryDocRepository>,
  dirRepo: ReturnType<typeof createMemoryDirRepository>,
  spaceId: string,
  stagedChange: StagedChange,
  operatorUserId: string,
  name: string,
): Promise<void> {
  try {
    const content = JSON.stringify(stagedChange, null, 2);
    const path = `${STAGED_DIR}/${stagedChange.id}.json`;
    await dirRepo.ensureParentDirs(path, { spaceId });
    await docRepo.put({
      path,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: '',
      preview: content.substring(0, 200),
      tags: ['skill_compose', `operator:${operatorUserId}`],
      summary: stagedChange.proposal.summary || `Create skill: ${name}`,
      semanticType: 'staged_change',
      indexing: 'disabled',
      scope: { spaceId },
    });
  } catch {
    // audit-doc write failed; the skill exists, so the operation still succeeds
  }
}

/**
 * A minimal valid starter skill: one agent task + one manual outcome. Built as
 * a raw object and parsed by `SkillComposeBundleSchema` (which preprocesses the
 * string goal into a subjective rubric), mirroring the agent compose path.
 */
export function buildStarterBundle(
  slug: string,
  name: string,
  goal: string,
  archetype: SkillArchetype,
): Record<string, unknown> {
  return {
    workflow: {
      slug,
      name,
      goal,
      mode: archetype,
      outcomes: [
        {
          id: 'primary-outcome',
          name: 'Primary outcome',
          evaluator: { type: 'manual', instruction: 'Describe what a successful run produces.' },
        },
      ],
      tasks: [
        { taskId: 'step-1', name: 'Step 1', goal: 'Define what this step does.', type: 'agent' },
      ],
    },
    manifest: { skillId: slug, name, goal, mode: archetype },
    rationale: `Created from the ${archetype} template.`,
  };
}

export function buildRatifiedComposeChange(
  slug: string,
  name: string,
  goal: string,
  archetype: SkillArchetype,
  bundle: SkillComposeBundle,
  operatorUserId: string,
): Record<string, unknown> {
  return buildOperatorRatifiedChange({
    slug,
    summary: `Create skill: ${name}`,
    rationale: `Operator created from the ${archetype} template. Goal: ${goal}`,
    bundle,
    operatorUserId,
  });
}

function buildOperatorRatifiedChange(args: {
  slug: string;
  summary: string;
  rationale: string;
  bundle: SkillComposeBundle;
  operatorUserId: string;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: 'skill_compose',
    source: 'operator',
    status: 'ratified',
    targetWorkflowSlug: args.slug,
    proposal: {
      summary: args.summary,
      rationale: args.rationale,
      confidence: 'high',
      ops: [{ op: 'skill_compose', bundle: args.bundle, authoredBySkillId: OPERATOR_AUTHOR }],
    },
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: now,
    resolvedAt: now,
    resolvedBy: args.operatorUserId,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    coachSessionId: NOT_A_COACH_SESSION,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
