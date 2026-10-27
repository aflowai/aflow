/**
 * Plan 330 D5/D6 — every space template, read statically.
 *
 * D6: nothing in a template names this machine, this repository or this
 * operator — no absolute path, port, owner/repo pair, binding/credential/
 * schedule id, or host other than its own api_definitions'. The planted
 * fixtures prove the guard fails on each.
 *
 * D5: every bundle it names resolves in the bundle catalog (in an order the
 * bundle install accepts), every help article exists, and every command a
 * readiness item names is one the host CLI accepts. Pages are checked against
 * the route manifest in `@aflow/web-product` (`spaceTemplatePages.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SpaceTemplate } from '@aflow/schemas';

import { SPACE_TEMPLATE_CATALOG } from '../spaceTemplateCatalog.js';
import {
  findSpaceTemplateLocalReferences,
  findSpaceTemplateUnresolvedReferences,
} from '../spaceTemplateGuard.js';

const [FIRST] = SPACE_TEMPLATE_CATALOG;
if (!FIRST) throw new Error('The catalog ships no space template.');

function planted(overrides: Partial<SpaceTemplate>): SpaceTemplate {
  return { ...FIRST.template, ...overrides };
}

function plantedDirective(responsibility: string): SpaceTemplate {
  return planted({ directives: { ...FIRST.template.directives, responsibility } });
}

// ----------------------------------------------------------------------------
// The host CLI, read from its own sources: `aflow <command>` is a package
// script that runs `src/<command>.ts`, `aflow harness <sub>` is a branch
// of the harness CLI's dispatch, and `aflow folder <bindingId> <sub>` one of
// the folder CLI's — the folder named before the verb, as the operator ruled.
// ----------------------------------------------------------------------------

const HOST_APP = new URL('../../../../apps/aflow-executor-host/', import.meta.url);

function dispatchedVerbs(source: string): Set<string> {
  const text = readFileSync(new URL(source, HOST_APP), 'utf8');
  return new Set([...text.matchAll(/command === '([a-z-]+)'/g)].map((match) => match[1] as string));
}

function hostCliCommands(): { top: Set<string>; harness: Set<string>; folder: Set<string> } {
  const manifest = JSON.parse(readFileSync(new URL('package.json', HOST_APP), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const top = new Set(
    Object.entries(manifest.scripts)
      .filter(
        ([name, script]) =>
          script.includes(`src/${name}.ts`) || script.includes(`src/${name}-cli.ts`),
      )
      .map(([name]) => name),
  );
  return {
    top,
    harness: dispatchedVerbs('src/harness-cli.ts'),
    folder: dispatchedVerbs('src/folder-cli.ts'),
  };
}

const CLI = hostCliCommands();

function unacceptedCommand(command: string): string | null {
  const [program, sub, third, fourth] = command.trim().split(/\s+/);
  if (program !== 'aflow') return `'${command}' is not an aflow command`;
  if (sub === undefined || !CLI.top.has(sub)) return `'aflow ${sub ?? ''}' is no host CLI command`;
  if (sub === 'harness' && (third === undefined || !CLI.harness.has(third))) {
    return `'aflow harness ${third ?? ''}' is no harness subcommand`;
  }
  // `aflow folder <bindingId> <verb>`: the folder first, then what is said about it.
  if (sub === 'folder' && (fourth === undefined || !CLI.folder.has(fourth))) {
    return `'aflow folder ${third ?? ''} ${fourth ?? ''}' is no folder subcommand`;
  }
  return null;
}

function unacceptedCommands(template: SpaceTemplate): string[] {
  return template.readiness.flatMap((item) => {
    if (item.command === undefined) return [];
    const problem = unacceptedCommand(item.command);
    return problem ? [`${template.templateId} ${item.key}: ${problem}`] : [];
  });
}

describe('space templates name nothing of this machine, repository or operator (D6)', () => {
  for (const listing of SPACE_TEMPLATE_CATALOG) {
    it(`${listing.template.templateId} is clean`, () => {
      expect(
        findSpaceTemplateLocalReferences(listing.template, {
          name: listing.name,
          tagline: listing.tagline,
          description: listing.description,
        }),
      ).toEqual([]);
    });
  }

  it('fails on a template carrying a planted absolute path', () => {
    const problems = findSpaceTemplateLocalReferences(
      plantedDirective('Work in /Users/someone/projects/app and report findings.'),
    );
    expect(problems).toEqual([
      expect.stringContaining("an absolute path '/Users/someone/projects/app'"),
    ]);
  });

  it('fails on a planted home-relative or Windows path', () => {
    expect(findSpaceTemplateLocalReferences(plantedDirective('Read ~/code/app first.'))).toEqual([
      expect.stringContaining('an absolute path'),
    ]);
    expect(
      findSpaceTemplateLocalReferences(plantedDirective('Read D:\\projects\\app first.')),
    ).toEqual([expect.stringContaining('an absolute path')]);
  });

  it('fails on a planted port number', () => {
    expect(
      findSpaceTemplateLocalReferences(plantedDirective('The preview listens on port 3001.')),
    ).toEqual([expect.stringContaining("a port number 'port 3001'")]);
  });

  it('fails on a planted owner/repo pair', () => {
    expect(
      findSpaceTemplateLocalReferences(plantedDirective('Open pull requests on acme/widgets.')),
    ).toEqual([expect.stringContaining("an owner/repo pair 'acme/widgets'")]);
  });

  it('fails on a planted binding, credential or schedule id', () => {
    expect(
      findSpaceTemplateLocalReferences(plantedDirective('Use the folder hb_k3x9q2 for reviews.')),
    ).toEqual([expect.stringContaining("a binding id 'hb_k3x9q2'")]);
    expect(
      findSpaceTemplateLocalReferences(
        plantedDirective('Renew schedule 3f1c2b4a-1d2e-4f50-8a9b-0c1d2e3f4a5b when it ends.'),
      ),
    ).toEqual([expect.stringContaining('an id')]);
    const withCredential = planted({
      readiness: [
        ...FIRST.template.readiness,
        // A key the item schema does not carry, as an author might slip one in.
        { ...FIRST.template.readiness[0], key: 'bind', credentialKey: 'github-pat' } as never,
      ],
    });
    expect(findSpaceTemplateLocalReferences(withCredential)).toEqual([
      expect.stringContaining("a credentialKey 'github-pat'"),
    ]);
  });

  it('fails on a host other than its own api_definition’s', () => {
    expect(
      findSpaceTemplateLocalReferences(plantedDirective('Check status at build.acme.dev daily.')),
    ).toEqual([expect.stringContaining("a host name 'build.acme.dev'")]);
    expect(
      findSpaceTemplateLocalReferences(plantedDirective('Call https://localhost first.')),
    ).toEqual([expect.stringContaining("a host name 'localhost'")]);
  });

  it('allows the host its own api_definition calls', () => {
    const withApi = planted({
      directives: {
        ...FIRST.template.directives,
        responsibility: 'Read pull requests from api.example.com.',
      },
      apiDefinitions: [
        {
          apiId: 'example',
          definition: {
            name: 'Example',
            baseUrl: 'https://api.example.com',
            authKind: 'none',
            endpoints: [],
          },
          conflictPolicy: 'skip',
        },
      ] as SpaceTemplate['apiDefinitions'],
    });
    expect(findSpaceTemplateLocalReferences(withApi)).toEqual([]);
  });
});

describe('space templates resolve what they name (D5)', () => {
  for (const { template } of SPACE_TEMPLATE_CATALOG) {
    it(`${template.templateId}: every bundle and help article resolves`, () => {
      expect(findSpaceTemplateUnresolvedReferences(template)).toEqual([]);
    });

    it(`${template.templateId}: every command is one the host CLI accepts`, () => {
      expect(unacceptedCommands(template)).toEqual([]);
    });
  }

  it('reports a bundle that is not in the catalog, and one installed before its prerequisite', () => {
    expect(
      findSpaceTemplateUnresolvedReferences(planted({ bundleIds: ['no-such-bundle'] })),
    ).toEqual([expect.stringContaining("bundle 'no-such-bundle' is not in the bundle catalog")]);
    expect(
      findSpaceTemplateUnresolvedReferences(planted({ bundleIds: ['local-publish'] })),
    ).toEqual([expect.stringContaining("'local-publish' needs 'local-code-review'")]);
  });

  it('reports a help article that does not exist', () => {
    expect(findSpaceTemplateUnresolvedReferences(planted({ help: ['no-such-article'] }))).toEqual([
      expect.stringContaining("help article 'no-such-article' does not exist"),
    ]);
  });

  it('reads the host CLI it checks commands against', () => {
    expect(CLI.top).toEqual(
      new Set(['pair', 'connect', 'harness', 'browser', 'folder', 'service']),
    );
    expect(CLI.folder).toEqual(new Set(['preview']));
    expect(CLI.harness.has('merge-posture')).toBe(true);
    expect(unacceptedCommand('aflow harness merge-posture <folder> when-green')).toBeNull();
    expect(unacceptedCommand('aflow connect <folder> --branch-prefix <p>')).toBeNull();
    expect(unacceptedCommand('aflow folder <bindingId> preview --command <command>')).toBeNull();
    expect(unacceptedCommand('aflow folder <bindingId> preview --clear')).toBeNull();
    // The verb follows the folder: the spelling the plan first wrote is not one.
    expect(unacceptedCommand('aflow folder preview <bindingId>')).not.toBeNull();
    expect(unacceptedCommand('aflow folder <bindingId>')).not.toBeNull();
    expect(unacceptedCommand('aflow harness merge <folder>')).not.toBeNull();
    expect(unacceptedCommand('yarn start')).not.toBeNull();
  });
});
