import { SkillCatalogEntrySchema, type SkillCatalogEntry } from '@aflow/schemas';

import { COMMISSION_CHANGE } from './commissionChange.js';
import { DAILY_TRADING_CYCLE } from './dailyTradingCycle.js';
import { KAGGLE_COMPETITION_OPTIMIZER } from './kaggleCompetitionOptimizer.js';
import { OPEN_PR_FROM_REQUEST } from './openPrFromRequest.js';
import { PR_SHEPHERD } from './prShepherd.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';
import { REVIEW_LOCAL_CHANGES } from './reviewLocalChanges.js';
import { REVIEW_PULL_REQUEST } from './reviewPullRequest.js';
import { TICKER_MARKET_DIGEST } from './tickerMarketDigest.js';
import { WEB_RESEARCH_BRIEF } from './webResearchBrief.js';
import { LITERATURE_SCAN } from './literatureScan.js';
import { FILM_SHOT_BATCH } from './filmShotBatch.js';
import { FILM_WORLD_DEVELOPMENT } from './filmWorldDevelopment.js';
import { FILM_CONCEPT } from './filmConcept.js';
import { EVAL_SUITE_DESIGN } from './evalSuiteDesign.js';
import { TEST_API_DEPENDENT, TEST_SKILL_A, TEST_SKILL_B, TEST_SKILL_C } from './testFixtures.js';

const RAW_SKILLS: readonly SkillCatalogEntry[] = [
  DAILY_TRADING_CYCLE,
  KAGGLE_COMPETITION_OPTIMIZER,
  OPEN_PR_FROM_REQUEST,
  PR_SHEPHERD,
  REVIEW_PULL_REQUEST,
  COMMISSION_CHANGE,
  REVIEW_LOCAL_CHANGES,
  PUBLISH_LOCAL_CHANGES,
  TICKER_MARKET_DIGEST,
  WEB_RESEARCH_BRIEF,
  LITERATURE_SCAN,
  FILM_SHOT_BATCH,
  FILM_WORLD_DEVELOPMENT,
  FILM_CONCEPT,
  EVAL_SUITE_DESIGN,
  // Hidden test fixtures — install-op unit tests reference these.
  TEST_SKILL_A,
  TEST_SKILL_B,
  TEST_SKILL_C,
  TEST_API_DEPENDENT,
];

/**
 * Ordered catalog of curated skills, validated through
 * `SkillCatalogEntrySchema` at module load. Skills are not standalone
 * store listings — bundles resolve their members here; entries with
 * `hidden: true` are test fixtures only.
 */
export const SKILL_CATALOG: readonly SkillCatalogEntry[] = Object.freeze(
  RAW_SKILLS.map((entry) => {
    const result = SkillCatalogEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        `Invalid skill "${entry.catalogId}" in catalog: ${result.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return result.data;
  }),
);

/** Convenience map for id-based lookup. */
const CATALOG_BY_ID: Readonly<Record<string, SkillCatalogEntry>> = Object.freeze(
  SKILL_CATALOG.reduce<Record<string, SkillCatalogEntry>>((acc, entry) => {
    acc[entry.catalogId] = entry;
    return acc;
  }, {}),
);

/**
 * Fetch a catalog entry by ID. Returns `null` for unknown IDs.
 */
export function getSkillCatalogEntry(catalogId: string): SkillCatalogEntry | null {
  return CATALOG_BY_ID[catalogId] ?? null;
}

/**
 * List all catalog entries. Excludes hidden entries by default.
 */
export function listSkillCatalog(opts?: { includeHidden?: boolean }): readonly SkillCatalogEntry[] {
  if (opts?.includeHidden) return SKILL_CATALOG;
  return SKILL_CATALOG.filter((e) => !e.hidden);
}
