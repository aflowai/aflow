import { and, eq, isNotNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { agents, createAgentRepository, createTenantContext, hostBindings } from '@aflow/database';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import {
  type BundledSkillStarterAgent,
  skillStarterAgentDefinition,
  type TenantId,
} from '@aflow/schemas';

export interface BundledAgentsResult {
  /** Slugs of the agents written by this call. */
  installedAgentSlugs: string[];
  /** Slugs already taken in the space, left as they are. */
  skippedAgentSlugs: string[];
  /** Agents not written, each with why and what writes it. */
  warnings: string[];
}

/** The space's folders a push may leave from: the ones a shepherd could tend. */
async function publishingFolders(tx: PostgresJsDatabase, spaceId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: hostBindings.hostBindingId })
    .from(hostBindings)
    .where(and(eq(hostBindings.spaceId, spaceId), isNotNull(hostBindings.branchPrefix)));
  return rows.map((row) => row.id).sort();
}

/**
 * Write each bundled agent that starts a skill, with one start per folder of
 * the space that allows pushes, each its folder input. A space with several
 * gets one agent starting the skill on every one rather than a guess at which
 * is meant, so a single schedule tends them all. A slug already taken keeps
 * what it holds; a space with no such folder gets no agent and a warning
 * naming what writes it. Runs inside the install's transaction.
 */
export async function applyBundledAgents(params: {
  agents: readonly BundledSkillStarterAgent[];
  tenantId: string;
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<BundledAgentsResult> {
  const result: BundledAgentsResult = {
    installedAgentSlugs: [],
    skippedAgentSlugs: [],
    warnings: [],
  };
  if (params.agents.length === 0) return result;
  const folders = await publishingFolders(params.tx, params.spaceId);
  const repo = createAgentRepository(params.tx, createTenantContext(params.tenantId as TenantId));

  for (const agent of params.agents) {
    const skill = getSkillCatalogEntry(agent.skillCatalogId);
    if (skill === null) {
      throw new Error(`Bundled agent starts "${agent.skillCatalogId}", which is no catalog skill.`);
    }
    const slug = skill.bundle.workflow.slug;
    const [taken] = await params.tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.spaceId, params.spaceId), eq(agents.slug, slug)))
      .limit(1);
    if (taken !== undefined) {
      result.skippedAgentSlugs.push(slug);
      continue;
    }
    if (folders.length === 0) {
      result.warnings.push(
        `The "${agent.name}" agent was not written: it starts ${skill.name} on each connected folder that allows pushes, and the space has none. ` +
          'Connect the folder with a publish prefix, then update this bundle from the Store to write the agent.',
      );
      continue;
    }
    await repo.create({
      spaceId: params.spaceId,
      slug: slug as Parameters<typeof repo.create>[0]['slug'],
      name: agent.name,
      description: agent.description,
      initialVersion: {
        version: '1',
        definition: skillStarterAgentDefinition({
          slug,
          catalogId: skill.catalogId,
          name: agent.name,
          description: agent.description,
          runs: folders.map((folder) => ({ [agent.folderInput]: folder })),
        }) as unknown as Parameters<typeof repo.create>[0]['initialVersion']['definition'],
      },
    });
    result.installedAgentSlugs.push(slug);
  }
  return result;
}
