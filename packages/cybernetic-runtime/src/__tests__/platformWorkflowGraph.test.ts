import { describe, it, expect } from 'vitest';
import {
  listPlatformSkillBundles,
  listSkillCatalog,
  type PlatformSkillBundleEntry,
} from '@aflow/platform-artifacts';
import {
  CyberneticEvalSuiteSchema,
  type SkillCatalogEntry,
  type WorkflowTask,
} from '@aflow/schemas';
import {
  materializeAndValidateSkillConfig,
  renderSkillDiagnostics,
  type SkillConfigToValidate,
} from '../skillValidity/skillValidity.js';

type BundleTaskCriteria = NonNullable<NonNullable<SkillConfigToValidate['bundle']>['taskCriteria']>;

/** Pull `taskCriteria` (taskId → criteria) out of an eval suite of unknown shape (platform). */
function platformTaskCriteria(evalSuite: unknown): BundleTaskCriteria {
  if (!evalSuite || typeof evalSuite !== 'object') return {};
  const criteria = (evalSuite as Record<string, unknown>)['taskCriteria'];
  if (!criteria || typeof criteria !== 'object') return {};
  return criteria as BundleTaskCriteria;
}

function disciplineSuite(
  evalSuite: unknown,
): NonNullable<SkillConfigToValidate['bundle']>['evalSuite'] {
  const parsed = CyberneticEvalSuiteSchema.safeParse(evalSuite);
  return parsed.success ? parsed.data : undefined;
}

/** Build the validate input for a platform skill bundle. */
function platformConfig(bundle: PlatformSkillBundleEntry): SkillConfigToValidate {
  return {
    tasks: bundle.workflow.tasks as unknown as WorkflowTask[],
    stateVariables: bundle.workflow
      .stateVariables as unknown as SkillConfigToValidate['stateVariables'],
    bundle: {
      taskCriteria: platformTaskCriteria(bundle.evalSuite),
      evalSuite: disciplineSuite(bundle.evalSuite),
      // Platform manifests carry refs (workflowSlug / evalSuiteRef), so exercise
      // the Slice-4 ref dimension against the real artifacts the bundle ships.
      manifestRefs: {
        workflowSlug: bundle.manifest.workflowSlug,
        evalSuiteRef: bundle.manifest.evalSuiteRef,
      },
      artifacts: {
        workflowSlug: bundle.workflow.slug,
        hasEvalSuite: bundle.evalSuite !== undefined,
      },
    },
  };
}

/** Build the validate input for a catalog skill entry. */
function catalogConfig(entry: SkillCatalogEntry): SkillConfigToValidate {
  const { workflow, manifest, evalSuite } = entry.bundle;
  const config: SkillConfigToValidate = {
    tasks: workflow.tasks,
    stateVariables: workflow.stateVariables,
    bundle: {
      uiOutput: manifest.uiOutput,
      // evalSuite is optional — process skills (e.g. the coding lane) carry none.
      taskCriteria: platformTaskCriteria(evalSuite),
      evalSuite: disciplineSuite(evalSuite),
    },
  };
  // A campaign-contracted skill's `$campaign` refs + `campaign_input` bindings
  // are only checkable with the contract + parameterized slots in scope.
  if (manifest.campaign) {
    config.campaign = {
      contract: manifest.campaign,
      goal: manifest.goal,
      outcomes: workflow.outcomes,
      goalCriteria: evalSuite?.goalCriteria ?? [],
      trajectoryCriteria: evalSuite?.trajectoryCriteria ?? [],
    };
  }
  return config;
}

describe('Plan 190 §7 — platform skills materialize + validate', () => {
  for (const bundle of listPlatformSkillBundles()) {
    it(`platform skill "${bundle.skillId}" is contract-valid`, () => {
      const { validity } = materializeAndValidateSkillConfig(platformConfig(bundle));
      if (validity.status === 'invalid') {
        throw new Error(
          `platform skill "${bundle.skillId}" is contract-invalid:\n${renderSkillDiagnostics(validity.diagnostics)}`,
        );
      }
      expect(validity.status).toBe('valid');
    });
  }
});

describe('Plan 190 §7 — catalog skills materialize + validate', () => {
  // includeHidden: the hidden install-op test fixtures ship in the build and
  // install via the same path; if one were broken, install would fail — so the
  // gate covers them too.
  for (const entry of listSkillCatalog({ includeHidden: true })) {
    it(`catalog skill "${entry.catalogId}" is contract-valid`, () => {
      const { validity } = materializeAndValidateSkillConfig(catalogConfig(entry));
      if (validity.status === 'invalid') {
        throw new Error(
          `catalog skill "${entry.catalogId}" is contract-invalid:\n${renderSkillDiagnostics(validity.diagnostics)}`,
        );
      }
      expect(validity.status).toBe('valid');
    });
  }
});
