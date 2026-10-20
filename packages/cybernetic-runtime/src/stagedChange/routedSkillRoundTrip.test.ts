/**
 * Every workflow writer stores the MATERIALIZED tasks, whose routed targets
 * carry guards derived from their source's routes. Each test here writes the
 * Local PR Shepherd (routes on `classify-failure`) through one writer, reads
 * the stored doc back, and validates it as the read side and `workflow.run.start`
 * do — the derived guards must not read as authored `when`s on the way back in.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { configureLogging } from '@aflow/observability';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import {
  routeGuardFor,
  WorkflowSchema,
  type SkillComposeBundle,
  type SkillManifest,
  type StagedChange,
  type TenantId,
  type Workflow,
} from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'error' });
});

interface FakeDoc {
  inlineContent: string;
  deletedAt: Date | null;
}

const docs = vi.hoisted(() => new Map<string, FakeDoc>());

const fakeRepo = vi.hoisted(() => {
  const repo = {
    getByPath: async (
      path: string,
      spaceId: string,
      opts?: { includeDeleted?: boolean },
    ): Promise<FakeDoc | null> => {
      const doc = docs.get(`${spaceId}:${path}`);
      if (!doc) return null;
      if (doc.deletedAt !== null && opts?.includeDeleted !== true) return null;
      return doc;
    },
    put: async (input: {
      path: string;
      inlineContent: string | null;
      scope: { spaceId: string };
    }) => {
      docs.set(`${input.scope.spaceId}:${input.path}`, {
        inlineContent: input.inlineContent ?? '',
        deletedAt: null,
      });
    },
    withTransaction: async <T>(fn: (txRepo: unknown) => Promise<T>): Promise<T> => fn(repo),
  };
  return repo;
});

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    createMemoryDocRepository: () => fakeRepo,
    ensureWorkflowRevisionSnapshot: async () => undefined,
  };
});

vi.mock('../skill.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    upsertSkillManifest: async (_ctx: unknown, manifest: SkillManifest) => {
      docs.set(`${SPACE_ID}:/skills/${manifest.skillId}/manifest.json`, {
        inlineContent: JSON.stringify(manifest),
        deletedAt: null,
      });
    },
    resolveSkillForWorkflow: async () => null,
  };
});

vi.mock('../skillProjectionReconciler.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    rebuildSkillProjection: async () => ({
      projection: { activationStatus: 'active', missingCapabilities: [] as string[] },
    }),
  };
});

const { installSkillCatalogEntry } = await import('./skillCatalogInstall.js');
const { updateSkillCatalogEntry } = await import('./skillCatalogUpdate.js');
const { applySkillComposeBundle, extractAndValidateBundle } =
  await import('./skillComposeApply.js');
const { applyOpsToSnapshot } = await import('./applyOpsToSnapshot.js');
const { runWorkflowProposalValidations } = await import('./proposalValidations.js');
const { applySkillSurfacePatch } = await import('../skillSurfacePatch.js');
const { ensureWorkflowDocValidity, materializeAndValidateSkillConfig } =
  await import('../skillValidity/skillValidity.js');

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-000000000001' as TenantId;
const CATALOG_ID = 'local-pr-shepherd';
const SLUG = 'local-pr-shepherd';
const WF_PATH = `/workflows/${SLUG}/workflow.json`;
const SOURCE = 'classify-failure';

function catalogEntry() {
  const entry = getSkillCatalogEntry(CATALOG_ID);
  if (!entry) throw new Error(`catalog entry ${CATALOG_ID} missing`);
  return entry;
}

function shepherdBundle(): SkillComposeBundle {
  return JSON.parse(JSON.stringify(catalogEntry().bundle)) as SkillComposeBundle;
}

function ctx() {
  return { tenantId: TENANT_ID as string, spaceId: SPACE_ID, db: {} as never, inTransaction: true };
}

function readStored(): Workflow {
  const doc = docs.get(`${SPACE_ID}:${WF_PATH}`);
  if (!doc) throw new Error(`${WF_PATH} was not written`);
  return WorkflowSchema.parse(JSON.parse(doc.inlineContent));
}

async function install(): Promise<Workflow> {
  const result = await installSkillCatalogEntry(ctx(), {
    bundle: catalogEntry().bundle,
    sourceCatalogId: CATALOG_ID,
    sourceVersion: catalogEntry().version,
  });
  expect(result.outcome).toBe('installed');
  return readStored();
}

/** Read the stored copy back and validate it the way the read side and run start do. */
function expectStoredValid(): Workflow {
  const doc = docs.get(`${SPACE_ID}:${WF_PATH}`);
  if (!doc) throw new Error(`${WF_PATH} was not written`);
  const readSide = ensureWorkflowDocValidity(JSON.parse(doc.inlineContent));
  expect(readSide.diagnostics).toEqual([]);
  expect(readSide.status).toBe('valid');

  const stored = readStored();
  const runStart = materializeAndValidateSkillConfig({
    tasks: stored.tasks,
    stateVariables: stored.stateVariables,
    output: stored.output,
    runInputs: stored.runInputs,
  }).validity;
  expect(runStart.diagnostics).toEqual([]);
  expect(runStart.status).toBe('valid');

  // The round trip is only meaningful while the stored copy carries derived guards.
  const source = stored.tasks.find((t) => t.taskId === SOURCE);
  const targets = (source?.routes ?? []).flatMap((r) => r.enable);
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    const when = stored.tasks.find((t) => t.taskId === target)?.when;
    expect(when?.derivedFromRoutes?.source).toBe(SOURCE);
  }
  return stored;
}

function composeProposal(bundle: SkillComposeBundle): StagedChange {
  return {
    id: '00000000-0000-0000-0000-0000000000c1',
    kind: 'skill_compose',
    status: 'proposed',
    proposal: {
      summary: 'Compose the shepherd',
      rationale: 'Round trip.',
      confidence: 'high',
      ops: [{ op: 'skill_compose' as const, bundle, authoredBySkillId: 'compose-skill' }],
    },
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-10-20T00:00:00.000Z',
    expiresAt: '2026-10-27T00:00:00.000Z',
    coachSessionId: '00000000-0000-0000-0000-0000000000c2',
  } as StagedChange;
}

function persist(workflow: Workflow): void {
  docs.set(`${SPACE_ID}:${WF_PATH}`, {
    inlineContent: JSON.stringify(WorkflowSchema.parse(workflow), null, 2),
    deletedAt: null,
  });
}

beforeEach(() => {
  docs.clear();
});

describe('a routed skill stays valid after every writer', () => {
  it('Store install', async () => {
    await install();
    expectStoredValid();
  });

  it('Store update over an installed copy, twice', async () => {
    await install();
    for (const sourceVersion of [catalogEntry().version + 1, catalogEntry().version + 2]) {
      const result = await updateSkillCatalogEntry(ctx(), {
        bundle: catalogEntry().bundle,
        sourceCatalogId: CATALOG_ID,
        sourceVersion,
      });
      expect(result.outcome).toBe('updated');
      expectStoredValid();
    }
  });

  it('Store update rewrites a copy stored before derived guards were marked', async () => {
    const installed = await install();
    persist({
      ...installed,
      tasks: installed.tasks.map((t) => {
        if (t.when?.derivedFromRoutes === undefined) return t;
        const { derivedFromRoutes: _mark, ...unmarked } = t.when;
        return { ...t, when: unmarked };
      }),
    });
    expect(ensureWorkflowDocValidity(readStored()).status).toBe('invalid');

    const result = await updateSkillCatalogEntry(ctx(), {
      bundle: catalogEntry().bundle,
      sourceCatalogId: CATALOG_ID,
      sourceVersion: catalogEntry().version + 1,
    });
    expect(result.outcome).toBe('updated');
    expectStoredValid();
  });

  it('compose apply — and a compose of the stored, materialized copy', async () => {
    const bundle = extractAndValidateBundle(composeProposal(shepherdBundle()));
    await applySkillComposeBundle(ctx(), bundle);
    const stored = expectStoredValid();

    docs.clear();
    const recomposed = shepherdBundle();
    recomposed.workflow.tasks = stored.tasks;
    const again = extractAndValidateBundle(composeProposal(recomposed));
    await applySkillComposeBundle(ctx(), again);
    expectStoredValid();
  });

  it('proposal apply — a task edit and a routes edit on the stored copy', async () => {
    const stored = await install();
    expect(
      runWorkflowProposalValidations(stored, { apiBindings: [], mcpBindings: [] }).contract
        .diagnostics,
    ).toEqual([]);

    const goalEdit = applyOpsToSnapshot({
      workflow: stored,
      evalSuites: new Map(),
      ops: [{ op: 'update_task_goal', taskId: SOURCE, newGoal: 'Pick the remedy.' }],
    });
    if (!goalEdit.ok) throw new Error(`${goalEdit.failureCode}: ${goalEdit.failureDetail}`);
    persist(goalEdit.candidateWorkflow!);
    expectStoredValid();

    // Swapping two routes' targets leaves each target's stored guard stale; the
    // apply must derive it again from the routes as edited.
    const routes = readStored().tasks.find((t) => t.taskId === SOURCE)!.routes!;
    const [first, second] = [routes[2]!, routes[3]!];
    const swapped = routes.map((r, i) =>
      i === 2 ? { ...r, enable: second.enable } : i === 3 ? { ...r, enable: first.enable } : r,
    );
    const routesEdit = applyOpsToSnapshot({
      workflow: readStored(),
      evalSuites: new Map(),
      ops: [{ op: 'update_task_routes', taskId: SOURCE, routes: swapped }],
    });
    if (!routesEdit.ok) throw new Error(`${routesEdit.failureCode}: ${routesEdit.failureDetail}`);
    persist(routesEdit.candidateWorkflow!);
    const edited = expectStoredValid();
    const target = second.enable[0]!;
    expect(edited.tasks.find((t) => t.taskId === target)?.when).toMatchObject({
      ...routeGuardFor(SOURCE, [first]),
      derivedFromRoutes: { source: SOURCE },
    });

    // Removing a route takes its guard and the dependency the derivation added
    // with it; what the target is left with is what its author declared.
    const dropped = routes[0]!.enable[0]!;
    const unrouted = applyOpsToSnapshot({
      workflow: readStored(),
      evalSuites: new Map(),
      ops: [{ op: 'update_task_routes', taskId: SOURCE, routes: swapped.slice(1) }],
    });
    if (!unrouted.ok) throw new Error(`${unrouted.failureCode}: ${unrouted.failureDetail}`);
    const after = unrouted.candidateWorkflow!.tasks.find((t) => t.taskId === dropped);
    const authored = shepherdBundle().workflow.tasks.find((t) => t.taskId === dropped);
    expect(after?.when).toBeUndefined();
    expect(after?.dependsOn ?? []).toEqual(authored?.dependsOn ?? []);
  });

  it('surface patch of the stored copy', async () => {
    const stored = await install();
    const result = await applySkillSurfacePatch(ctx(), {
      slug: SLUG,
      tokens: { workflowRevision: stored.revision },
      workflow: { ...stored, name: 'Local PR Shepherd (edited)' } as Record<string, unknown>,
    });
    expect(result).toMatchObject({ ok: true, newRevision: stored.revision + 1 });
    expect(expectStoredValid().name).toBe('Local PR Shepherd (edited)');
  });
});
