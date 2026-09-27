/**
 * Contract: the root Dockerfile carries every workspace through both stages.
 *
 * Builder stage — each workspace package.json is copied before
 * `yarn install --immutable`. A workspace on disk with no matching
 * `COPY .../package.json` line diverges Yarn's project layout from yarn.lock and
 * Cloud Build fails with YN0028.
 *
 * Production stage — each workspace's build output is copied from the builder.
 * `.dockerignore` excludes every build output directory, so an omitted
 * `COPY --from=builder` line is the only thing standing between a green image build
 * and a container that dies at startup on ERR_MODULE_NOT_FOUND — invisible until
 * the deploy step runs it.
 *
 * The two stages tolerate different absences, and the asymmetry is the point. A
 * workspace missing from the builder breaks `yarn install --immutable` whatever
 * it is for, so that list admits no exceptions. A workspace missing from the
 * production stage only fails if something in the image imports it — and a
 * workspace that ships outside the image never does. `phoenix.shipsInImage:
 * false` in its own manifest is how it says so, which keeps the decision beside
 * the workspace it describes rather than in a list here that would drift from it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');

function workspacePackageNames(segment: 'apps' | 'packages'): string[] {
  const base = join(REPO_ROOT, segment);
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(base, name, 'package.json')))
    .sort();
}

function extractBuilderStageBeforeInstall(dockerfile: string): string {
  const prodSplit = /\nFROM [^\n]+ AS production\n/.exec(dockerfile);
  const builder =
    prodSplit?.index !== undefined ? dockerfile.slice(0, prodSplit.index) : dockerfile;
  const installIdx = builder.indexOf('RUN yarn install --immutable');
  if (installIdx === -1) {
    throw new Error('Dockerfile: expected RUN yarn install --immutable in builder stage');
  }
  return builder.slice(0, installIdx);
}

function extractProductionStage(dockerfile: string): string {
  const prodSplit = /\nFROM [^\n]+ AS production\n/.exec(dockerfile);
  if (prodSplit?.index === undefined) {
    throw new Error('Dockerfile: expected a `FROM ... AS production` stage');
  }
  return dockerfile.slice(prodSplit.index);
}

/**
 * Whether a workspace's build output belongs in the image at all. Declared by the
 * workspace, not listed here, so adding one is a decision made where it applies.
 */
function shipsInImage(segment: 'apps' | 'packages', name: string): boolean {
  const raw: unknown = JSON.parse(
    readFileSync(join(REPO_ROOT, segment, name, 'package.json'), 'utf8'),
  );
  const phoenix =
    typeof raw === 'object' && raw !== null
      ? (raw as { phoenix?: { shipsInImage?: unknown } }).phoenix
      : undefined;
  return phoenix?.shipsInImage !== false;
}

/** The directory `yarn build` emits for a workspace, or null when it has no build. */
function buildOutputDir(segment: 'apps' | 'packages', name: string): string | null {
  const raw: unknown = JSON.parse(
    readFileSync(join(REPO_ROOT, segment, name, 'package.json'), 'utf8'),
  );
  if (typeof raw !== 'object' || raw === null) return null;
  const scripts = (raw as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return null;
  const build = (scripts as Record<string, unknown>)['build'];
  if (typeof build !== 'string') return null;
  return build.includes('next build') ? '.next' : 'dist';
}

function packageJsonCopyNames(
  segment: 'apps' | 'packages',
  dockerfileSlice: string,
  stage: 'builder' | 'production' = 'builder',
): string[] {
  const from = stage === 'production' ? 'COPY --from=builder /app/' : 'COPY ';
  const pattern = new RegExp(
    `^${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${segment}\\/([^/]+)\\/package\\.json ${segment}\\/\\1\\/$`,
    'gm',
  );
  const names: string[] = [];
  for (const m of dockerfileSlice.matchAll(pattern)) {
    names.push(m[1] as string);
  }
  return [...new Set(names)].sort();
}

describe('Dockerfile workspace manifests', () => {
  it('lists every apps/* and packages/* workspace package.json in the builder stage before immutable install', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const slice = extractBuilderStageBeforeInstall(dockerfile);

    expect(packageJsonCopyNames('apps', slice)).toEqual(workspacePackageNames('apps'));
    expect(packageJsonCopyNames('packages', slice)).toEqual(workspacePackageNames('packages'));
  });

  it('copies every built workspace output into the production stage', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const production = extractProductionStage(dockerfile);

    const missing: string[] = [];
    for (const segment of ['apps', 'packages'] as const) {
      for (const name of workspacePackageNames(segment)) {
        if (!shipsInImage(segment, name)) continue;
        const out = buildOutputDir(segment, name);
        if (out === null) continue;
        const target = `${segment}/${name}/${out}`;
        if (!production.includes(`COPY --from=builder /app/${target} ${target}`)) {
          missing.push(target);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('resolves every workspace manifest in the production stage', () => {
    // `yarn workspaces focus --all --production` runs against the copied root
    // lockfile, which names every workspace. One missing manifest diverges the
    // project layout from the lock — the YN0028 class again, reached from the
    // other stage. Shipping outside the image excuses the `dist` copy, never
    // this: the lockfile does not know about that distinction.
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const production = extractProductionStage(dockerfile);

    for (const segment of ['apps', 'packages'] as const) {
      expect(packageJsonCopyNames(segment, production, 'production')).toEqual(
        workspacePackageNames(segment),
      );
    }
  });

  it('keeps a workspace that ships outside the image in the builder stage anyway', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const slice = extractBuilderStageBeforeInstall(dockerfile);

    for (const segment of ['apps', 'packages'] as const) {
      const outside = workspacePackageNames(segment).filter((n) => !shipsInImage(segment, n));
      for (const name of outside) {
        expect(
          packageJsonCopyNames(segment, slice),
          `${segment}/${name} opts out of the image, which does not excuse it from the ` +
            'builder stage: `yarn install --immutable` validates the whole workspace set.',
        ).toContain(name);
      }
    }
  });
});

/**
 * The same startup failure, reached from the other side. `.dockerignore` drops
 * every build output directory so the image builds its own, but TypeScript's
 * incremental stamp is not in one of those directories — it sits beside the
 * tsconfig that produced it. Carried into the build context without the `dist`
 * it describes, it tells `tsc -b` the output is already current and nothing is
 * emitted, so the image builds green and the container dies on a module that
 * was never written.
 *
 * Running `yarn typecheck` is what leaves those stamps on disk, and the repo
 * asks for it before committing — so the ordering that produces a broken image
 * is the ordinary one.
 */
describe('.dockerignore build stamps', () => {
  const dockerignore = readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('drops the incremental stamp wherever it drops the output', () => {
    expect(dockerignore).toContain('**/dist');
    expect(dockerignore).toContain('**/*.tsbuildinfo');
  });
});
