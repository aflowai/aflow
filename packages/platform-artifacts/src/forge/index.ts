/**
 * The loop's skills' forge providers, named from a repository's host (Plan 340
 * D1). The skills ask here for the forge they speak to and never name a
 * provider themselves.
 */
import { type ForgeProviderId, requireForgeProvider } from '@aflow/schemas';
import { GITHUB_SKILL_FORGE } from './github/skillForge.js';
import type { SkillForge } from './vocabulary.js';

export type * from './vocabulary.js';

const SKILL_FORGES: Readonly<Record<ForgeProviderId, SkillForge>> = {
  github: GITHUB_SKILL_FORGE,
};

/**
 * The provider of the forge a repository on `host` lives on. With no host,
 * the repo coordinate's default host names it: a skill is built once, before
 * any folder is read, so it is built against that forge.
 */
export function skillForgeFor(host?: string): SkillForge {
  return SKILL_FORGES[requireForgeProvider(host)];
}
