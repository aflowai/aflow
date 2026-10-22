import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, hostBindings } from '@aflow/database';
import { getSkillBundleEntry } from '@aflow/platform-artifacts';
import { AgentDefinitionSchema, type BundledSkillStarterAgent } from '@aflow/schemas';

const created: { slug: string; definition: unknown }[] = [];

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    createAgentRepository: () => ({
      create: (input: { slug: string; initialVersion: { definition: unknown } }) => {
        created.push({ slug: input.slug, definition: input.initialVersion.definition });
        return Promise.resolve({});
      },
    }),
  };
});

const { applyBundledAgents } = await import('./applyBundledAgents.js');

const SHEPHERD_AGENTS: readonly BundledSkillStarterAgent[] =
  getSkillBundleEntry('local-shepherd')?.agents ?? [];

/**
 * A transaction answering the two reads the install makes: the space's
 * folders that allow pushes, and whether the agent's slug is taken.
 */
function space(params: { folders: string[]; takenSlugs?: string[] }): PostgresJsDatabase {
  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === hostBindings) {
          return Promise.resolve(params.folders.map((id) => ({ id })));
        }
        if (table === agents) {
          return {
            limit: () =>
              Promise.resolve((params.takenSlugs ?? []).map((slug) => ({ id: `agent-${slug}` }))),
          };
        }
        throw new Error('the install read a table this space does not answer');
      },
    }),
  });
  return { select } as unknown as PostgresJsDatabase;
}

async function install(params: { folders: string[]; takenSlugs?: string[] }) {
  return await applyBundledAgents({
    agents: SHEPHERD_AGENTS,
    tenantId: '00000000-0000-4000-8000-00000000000a',
    spaceId: '00000000-0000-4000-8000-000000000001',
    tx: space(params),
  });
}

/** The folders the agent's starts name, in order; a folder's start and its fail step name one. */
function startedFolders(definition: unknown): unknown[] {
  const folders = AgentDefinitionSchema.parse(definition)
    .steps.filter((step) => step.operation === 'workflow.run.start')
    .map((step) => (step.config as { inputs: { bindingId: unknown } }).inputs.bindingId);
  return [...new Set(folders)];
}

describe('the Local PR Shepherd agent a bundle install writes', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('is the bundle’s one skill starter', () => {
    expect(SHEPHERD_AGENTS.map((agent) => agent.skillCatalogId)).toEqual(['local-pr-shepherd']);
  });

  it('starts the skill on the space’s one folder that allows pushes', async () => {
    const result = await install({ folders: ['hb_aflow'] });
    expect(result).toEqual({
      installedAgentSlugs: ['local-pr-shepherd'],
      skippedAgentSlugs: [],
      warnings: [],
    });
    expect(created.map((agent) => agent.slug)).toEqual(['local-pr-shepherd']);
    expect(startedFolders(created[0]?.definition)).toEqual(['hb_aflow']);
  });

  it('is written where the space has two folders that allow pushes, starting the skill on each', async () => {
    const result = await install({ folders: ['hb_aflow', 'hb_docs'] });
    expect(result).toEqual({
      installedAgentSlugs: ['local-pr-shepherd'],
      skippedAgentSlugs: [],
      warnings: [],
    });
    expect(created).toHaveLength(1);
    expect(startedFolders(created[0]?.definition)).toEqual(['hb_aflow', 'hb_docs']);
  });

  it('is written for a space of many folders that allow pushes, two steps a folder', async () => {
    const folders = Array.from({ length: 16 }, (_, i) => `hb_${String(i + 1).padStart(2, '0')}`);
    const result = await install({ folders });
    expect(result.installedAgentSlugs).toEqual(['local-pr-shepherd']);
    expect(startedFolders(created[0]?.definition)).toEqual(folders);
    expect(AgentDefinitionSchema.parse(created[0]?.definition).steps).toHaveLength(32);
  });

  it('is not written where the space has no folder that allows pushes, and the warning says what writes it', async () => {
    const result = await install({ folders: [] });
    expect(result.installedAgentSlugs).toEqual([]);
    expect(created).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/has none\. Connect the folder with a publish prefix, then update/),
    ]);
  });

  it('leaves an agent already under the slug as it is', async () => {
    const result = await install({
      folders: ['hb_aflow', 'hb_docs'],
      takenSlugs: ['local-pr-shepherd'],
    });
    expect(result).toEqual({
      installedAgentSlugs: [],
      skippedAgentSlugs: ['local-pr-shepherd'],
      warnings: [],
    });
    expect(created).toEqual([]);
  });
});
