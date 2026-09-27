import { describe, it, expect } from 'vitest';
import { SkillComposeBundleSchema, StagedChangeSchema } from '@aflow/schemas';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';

import {
  buildCloneBundle,
  buildStarterBundle,
  buildRatifiedComposeChange,
  cloneOperatorSkill,
  createOperatorSkill,
} from './operatorSkillCreate.js';

describe('buildStarterBundle — the starter is valid for every archetype', () => {
  for (const archetype of ['process', 'project'] as const) {
    it(`${archetype}: schema-valid and validator-clean (so applySkillComposeBundle accepts it)`, () => {
      const raw = buildStarterBundle('my-skill', 'My Skill', 'Do a useful thing.', archetype);
      const parsed = SkillComposeBundleSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const { validity } = materializeAndValidateSkillConfig({
        tasks: parsed.data.workflow.tasks,
        stateVariables: parsed.data.workflow.stateVariables,
        output: parsed.data.workflow.output,
        mode: parsed.data.workflow.mode,
        campaign: {
          contract: parsed.data.manifest.campaign,
          goal: parsed.data.manifest.goal,
          outcomes: parsed.data.workflow.outcomes,
        },
      });
      expect(validity.status).not.toBe('invalid');
      expect(parsed.data.workflow.slug).toBe(parsed.data.manifest.skillId);
    });
  }
});

describe('buildRatifiedComposeChange — the staged change is schema-valid', () => {
  it('parses against StagedChangeSchema (operator-source, ratified skill_compose)', () => {
    const bundle = SkillComposeBundleSchema.parse(
      buildStarterBundle('my-skill', 'My Skill', 'Do a useful thing.', 'process'),
    );
    const raw = buildRatifiedComposeChange(
      'my-skill',
      'My Skill',
      'Do a useful thing.',
      'process',
      bundle,
      'user-1',
    );
    const parsed = StagedChangeSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBe('operator');
      expect(parsed.data.status).toBe('ratified');
      expect(parsed.data.kind).toBe('skill_compose');
    }
  });
});

describe('createOperatorSkill — slug guard', () => {
  it('rejects a name that does not produce a valid slug before touching the db', async () => {
    const result = await createOperatorSkill({
      tenantId: '00000000-0000-0000-0000-000000000001' as never,
      spaceId: '00000000-0000-0000-0000-000000000002',
      name: '🌟', // slugifies to '' → invalid
      goal: 'whatever',
      archetype: 'process',
      operatorUserId: 'user-1',
      db: {} as never, // never reached
    });
    expect(result).toMatchObject({ ok: false, status: 422, code: 'invalid_slug' });
  });
});

describe('buildCloneBundle — a clone of a real catalog skill is a valid compose bundle', () => {
  it('clones the kaggle optimizer with its campaign contract intact, evals excluded', () => {
    const entry = getSkillCatalogEntry('kaggle-competition-optimizer');
    expect(entry).toBeDefined();
    if (!entry) return;

    // Persisted docs carry MATERIALIZED tasks plus server identity fields; the
    // clone reads the persisted form, so the fixture must simulate both.
    const { materializedTasks } = materializeAndValidateSkillConfig({
      tasks: entry.bundle.workflow.tasks,
      stateVariables: entry.bundle.workflow.stateVariables,
      output: entry.bundle.workflow.output,
    });
    const sourceWorkflow = {
      ...entry.bundle.workflow,
      tasks: materializedTasks,
      id: 'wf-1',
      origin: 'store',
      sourceCatalogId: entry.catalogId,
      revision: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
    } as unknown as Record<string, unknown>;

    const raw = buildCloneBundle({
      slug: 'kaggle-simulation-agent',
      name: 'Kaggle Simulation Agent',
      sourceSlug: entry.bundle.workflow.slug,
      sourceName: entry.bundle.workflow.name,
      sourceWorkflow,
      sourceManifest: entry.bundle.manifest as unknown as Record<string, unknown>,
      sourceActivation: (entry.bundle.activation ?? null) as Record<string, unknown> | null,
    });

    const parsed = SkillComposeBundleSchema.safeParse(raw);
    expect(parsed.error?.message).toBeUndefined();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.workflow.slug).toBe('kaggle-simulation-agent');
    expect(parsed.data.manifest.skillId).toBe('kaggle-simulation-agent');
    expect(parsed.data.manifest.name).toBe('Kaggle Simulation Agent');
    expect(parsed.data.manifest.campaign).toEqual(entry.bundle.manifest.campaign);
    expect(parsed.data.workflow.tasks.map((t) => t.taskId)).toEqual(
      entry.bundle.workflow.tasks.map((t) => t.taskId),
    );
    // Evals are the Coach's to re-author for the clone.
    expect(parsed.data.evalSuite).toBeUndefined();

    const { validity } = materializeAndValidateSkillConfig({
      tasks: parsed.data.workflow.tasks,
      stateVariables: parsed.data.workflow.stateVariables,
      output: parsed.data.workflow.output,
      mode: parsed.data.workflow.mode,
      campaign: {
        contract: parsed.data.manifest.campaign,
        goal: parsed.data.manifest.goal,
        outcomes: parsed.data.workflow.outcomes,
      },
    });
    expect(validity.status).not.toBe('invalid');
  });

  it('degrades to workflow-derived manifest fields when the manifest doc is missing', () => {
    const starter = SkillComposeBundleSchema.parse(
      buildStarterBundle('source-skill', 'Source Skill', 'Do a useful thing.', 'process'),
    );
    const raw = buildCloneBundle({
      slug: 'source-skill-copy',
      name: 'Source Skill copy',
      sourceSlug: 'source-skill',
      sourceName: 'Source Skill',
      sourceWorkflow: starter.workflow as unknown as Record<string, unknown>,
      sourceManifest: null,
      sourceActivation: null,
    });
    const parsed = SkillComposeBundleSchema.safeParse(raw);
    expect(parsed.error?.message).toBeUndefined();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.manifest.skillId).toBe('source-skill-copy');
    expect(parsed.data.manifest.mode).toBe('process');
    expect(parsed.data.activation).toBeUndefined();
  });
});

describe('cloneOperatorSkill — slug guard', () => {
  it('rejects a name that does not produce a valid slug before touching the db', async () => {
    const result = await cloneOperatorSkill({
      tenantId: '00000000-0000-0000-0000-000000000001' as never,
      spaceId: '00000000-0000-0000-0000-000000000002',
      sourceSlug: 'anything',
      name: '🌟',
      operatorUserId: 'user-1',
      db: {} as never, // never reached
    });
    expect(result).toMatchObject({ ok: false, status: 422, code: 'invalid_slug' });
  });
});
