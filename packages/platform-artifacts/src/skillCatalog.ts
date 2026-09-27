/**
 * Skill Catalog — re-export barrel.
 *
 * Implementation lives in `./skillCatalog/` (one module per skill family).
 * This file preserves existing `./skillCatalog.js` import paths.
 *
 * @packageDocumentation
 */
export { SKILL_CATALOG, getSkillCatalogEntry, listSkillCatalog } from './skillCatalog/index.js';
