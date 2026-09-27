import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import { ALL_PLATFORM_WORKFLOWS } from '@aflow/platform-artifacts';
import type { WorkflowTask } from '@aflow/schemas';
import { materializeAndValidateSkillConfig } from '../skillValidity/skillValidity.js';

// Same interop + settings as the runtime enforcer (agentOutputValidator /
// AiHandler validateToolArgs) — the guard must validate with the machinery the
// runner actually faces.
interface AjvInstance {
  compile(schema: Record<string, unknown>): (data: unknown) => boolean;
}
type AjvConstructor = new (opts: { allErrors?: boolean; strict?: boolean }) => AjvInstance;
const mod = AjvModule as unknown as { default?: AjvConstructor };
const Ajv: AjvConstructor = mod.default ?? (AjvModule as unknown as AjvConstructor);
const ajv: AjvInstance = new Ajv({ allErrors: true, strict: false });

function unionVariants(
  schema: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!schema) return undefined;
  const variants = schema['anyOf'] ?? schema['oneOf'];
  if (!Array.isArray(variants)) return undefined;
  return variants.filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
}

function materialize(workflow: {
  slug: string;
  tasks: WorkflowTask[];
  stateVariables?: unknown;
  output?: unknown;
}): WorkflowTask[] {
  const { materializedTasks, validity } = materializeAndValidateSkillConfig({
    tasks: workflow.tasks,
    stateVariables: workflow.stateVariables as never,
    output: workflow.output as never,
  });
  expect(validity.status, `${workflow.slug}: ${JSON.stringify(validity.diagnostics)}`).not.toBe(
    'invalid',
  );
  return materializedTasks;
}

describe('platform workflow output contracts survive materialization', () => {
  // The runner validates against the MATERIALIZED contract (op-bound port
  // derivation applied), not the authored one. Grafting root-level
  // properties/required onto a union root makes every variant that omits the
  // field unsatisfiable — the runner is then forced into whichever branch
  // carries it, regardless of its actual classification. The founding case:
  // bind-capability's elicit-target union + catalogId/expectedVersion ports
  // left store_install as the only emittable scope.
  it('no union-rooted contract gains root-level properties or required', () => {
    for (const workflow of ALL_PLATFORM_WORKFLOWS) {
      const materialized = materialize(workflow);
      for (const task of materialized) {
        const schema = task.outputContract?.schema;
        const variants = unionVariants(schema);
        if (!variants) continue;
        expect(
          schema!['required'],
          `${workflow.slug}/${task.taskId}: union root grew required`,
        ).toBeUndefined();
        expect(
          schema!['properties'],
          `${workflow.slug}/${task.taskId}: union root grew properties`,
        ).toBeUndefined();
      }
    }
  });
});

describe('bind-capability elicit-target — every scope is emittable', () => {
  const SAMPLES: Record<string, Record<string, unknown>> = {
    store_install: {
      scope: 'store_install',
      proceedWithApiChange: false,
      catalogId: 'vercel',
      expectedVersion: 1,
      listingInstallState: 'not_installed',
      targetSummary: 'Install the Vercel connector.',
    },
    new_binding: {
      scope: 'new_binding',
      proceedWithApiChange: true,
      apiId: 'acme',
      targetSummary: 'Wire the Acme API.',
    },
    extend_existing: {
      scope: 'extend_existing',
      proceedWithApiChange: true,
      apiId: 'vercel',
      targetSummary: 'Add 4 web-analytics endpoints to the existing Vercel API.',
    },
    egress_update: {
      scope: 'egress_update',
      proceedWithApiChange: true,
      apiId: 'kaggle',
      targetSummary: 'Allow the GCS redirect host.',
    },
    no_api_change__recommend_skill_change: {
      scope: 'no_api_change__recommend_skill_change',
      proceedWithApiChange: false,
      advisory: {
        recommendation: 'use_existing_endpoint',
        rationale: 'The listDeployments endpoint already covers this call.',
      },
      targetSummary: 'No API change needed.',
    },
  };

  it('a valid sample output exists and validates for every declared scope', () => {
    const workflow = ALL_PLATFORM_WORKFLOWS.find((w) => w.slug === 'bind-capability');
    expect(workflow).toBeDefined();
    const materialized = materialize(workflow!);
    const elicit = materialized.find((t) => t.taskId === 'elicit-target');
    expect(elicit).toBeDefined();
    const schema = elicit!.outputContract?.schema as Record<string, unknown>;
    const variants = unionVariants(schema);
    expect(variants).toBeDefined();

    const declaredScopes = variants!
      .map((v) => {
        const props = v['properties'] as Record<string, unknown> | undefined;
        const scope = props?.['scope'] as Record<string, unknown> | undefined;
        return (scope?.['const'] ??
          (Array.isArray(scope?.['enum']) ? scope['enum'][0] : undefined)) as string | undefined;
      })
      .filter((s): s is string => typeof s === 'string');
    expect(declaredScopes.length).toBe(variants!.length);

    const validate = ajv.compile(schema);
    for (const scope of declaredScopes) {
      const sample = SAMPLES[scope];
      expect(sample, `scope "${scope}" has no sample — add one to this guard`).toBeDefined();
      expect(
        validate(sample),
        `scope "${scope}" sample does not validate against the MATERIALIZED contract — ` +
          'this scope is unemittable by the runner',
      ).toBe(true);
    }
  });
});
