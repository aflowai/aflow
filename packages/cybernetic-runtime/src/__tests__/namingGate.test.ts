import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import {
  assertPatternAbsentInFiles,
  assertPatternAbsentInTree,
  extMatches,
} from './grepGateHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Monorepo root: packages/cybernetic-runtime/src/__tests__ → ../../../.. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const CODE_AND_SCRIPTS = ['packages', 'apps', 'scripts'] as const;

function namingExclude(rel: string): boolean {
  if (rel.startsWith('docs/')) return true;
  if (rel.endsWith('/namingGate.test.ts')) return true;
  if (rel === 'packages/database/src/tenant.ts') return true;
  if (rel.startsWith('packages/database/src/tenant/migrations/')) return true;
  if (rel === 'packages/redis/src/entityEventsLegacyRelabel.ts') return true;
  return false;
}

describe('104a naming gates (§6)', () => {
  const tsTsxMjs = (rel: string) => extMatches(rel, ['.ts', '.tsx', '.mjs']);
  const tsTsx = (rel: string) => extMatches(rel, ['.ts', '.tsx']);
  const tsOnly = (rel: string) => extMatches(rel, ['.ts']);

  it('forbids legacy cybernetic agent IDs in code', () => {
    assertPatternAbsentInTree(
      /cybernetic-executive|cybernetic-worker|cybernetic-learner|cybernetic-judge/,
      {
        repoRoot: REPO_ROOT,
        roots: CODE_AND_SCRIPTS,
        includeFile: tsTsxMjs,
        excludeFile: namingExclude,
      },
    );
    assertPatternAbsentInFiles(
      /cybernetic-executive|cybernetic-worker|cybernetic-learner|cybernetic-judge/,
      REPO_ROOT,
      ['README.md', 'scripts/README.md'],
    );
  });

  it('forbids legacy factory names in code', () => {
    assertPatternAbsentInTree(
      /createExecutiveAgentDefinition|createWorkerAgentDefinition|createLearnerAgentDefinition|createJudgeAgentDefinition/,
      {
        repoRoot: REPO_ROOT,
        roots: CODE_AND_SCRIPTS,
        includeFile: tsTsxMjs,
        excludeFile: namingExclude,
      },
    );
  });

  it('forbids legacy cybernetic source filenames in code', () => {
    assertPatternAbsentInTree(/(learnerTrigger|learnerCrud|executivePrompt)\.ts/, {
      repoRoot: REPO_ROOT,
      roots: CODE_AND_SCRIPTS,
      includeFile: tsTsxMjs,
      excludeFile: namingExclude,
    });
  });

  it('forbids WorkerReflection schema names in code', () => {
    assertPatternAbsentInTree(/\bWorkerReflection(Schema)?\b/, {
      repoRoot: REPO_ROOT,
      roots: CODE_AND_SCRIPTS,
      includeFile: tsOnly,
      excludeFile: namingExclude,
    });
    assertPatternAbsentInTree(/\bWorkerReflection(Schema)?\b/, {
      repoRoot: REPO_ROOT,
      roots: CODE_AND_SCRIPTS,
      includeFile: (rel) => extMatches(rel, ['.tsx']),
      excludeFile: namingExclude,
    });
  });

  it('forbids ExecutiveBackDoorDenied in code', () => {
    assertPatternAbsentInTree(/ExecutiveBackDoorDenied/, {
      repoRoot: REPO_ROOT,
      roots: CODE_AND_SCRIPTS,
      includeFile: tsTsx,
      excludeFile: namingExclude,
    });
  });

  it('forbids ExecutiveAttention in code', () => {
    assertPatternAbsentInTree(/ExecutiveAttention/, {
      repoRoot: REPO_ROOT,
      roots: CODE_AND_SCRIPTS,
      includeFile: tsTsxMjs,
      excludeFile: namingExclude,
    });
  });

  it('forbids legacy learner-* system procedure slugs in code', () => {
    assertPatternAbsentInTree(
      /\blearner-(scarcity-sweep|consolidate-interaction|eval-review|review-artifacts)\b/,
      {
        repoRoot: REPO_ROOT,
        roots: CODE_AND_SCRIPTS,
        includeFile: tsTsxMjs,
        excludeFile: namingExclude,
      },
    );
  });

  it('forbids legacy entity worker/learner event prefixes in TS/TSX', () => {
    assertPatternAbsentInTree(/entity\.(learner|worker)\./, {
      repoRoot: REPO_ROOT,
      roots: CODE_AND_SCRIPTS,
      includeFile: tsOnly,
      excludeFile: namingExclude,
    });
    assertPatternAbsentInTree(/entity\.(learner|worker)\./, {
      repoRoot: REPO_ROOT,
      roots: CODE_AND_SCRIPTS,
      includeFile: (rel) => extMatches(rel, ['.tsx']),
      excludeFile: namingExclude,
    });
  });

  it('forbids legacy two-segment entity event types in TS/TSX', () => {
    assertPatternAbsentInTree(
      /\bentity\.(bootstrapped|graduated|directives_updated|directives_staged|training_mode_changed)\b/,
      {
        repoRoot: REPO_ROOT,
        roots: CODE_AND_SCRIPTS,
        includeFile: tsOnly,
        excludeFile: namingExclude,
      },
    );
    assertPatternAbsentInTree(
      /\bentity\.(bootstrapped|graduated|directives_updated|directives_staged|training_mode_changed)\b/,
      {
        repoRoot: REPO_ROOT,
        roots: CODE_AND_SCRIPTS,
        includeFile: (rel) => extMatches(rel, ['.tsx']) && namingExclude(rel) === false,
        excludeFile: namingExclude,
      },
    );
  });
});
