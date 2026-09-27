/**
 * The derived file is what a collaborator installs from, so every transform
 * here fails loudly rather than emitting a remainder. A consumer file that
 * still builds asks a machine with Docker and nothing else to compile the
 * product; one pinned by tag lets the image move under an installed instance.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BAKED_API_PORT,
  BundleTransformError,
  bundleStillBuilds,
  consumerCompose,
  floatingImages,
  relativeBindSources,
} from '../applianceBundle.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const source = readFileSync(join(repoRoot, 'docker-compose.local.yml'), 'utf-8');
const IMAGE = `ghcr.io/aflowai/aflow-appliance@sha256:${'a'.repeat(64)}`;

/** Whatever the file names by tag, pinned — the generator resolves these for real. */
const PINNED = Object.fromEntries(
  floatingImages(source).map((reference, index) => [
    reference,
    `sha256:${String(index + 1).repeat(64)}`,
  ]),
);

describe('the consumer Compose file', () => {
  const { yaml, changes } = consumerCompose(source, { image: IMAGE, pinned: PINNED });

  it('describes nothing to build', () => {
    expect(bundleStillBuilds(source)).toBe(true);
    expect(bundleStillBuilds(yaml)).toBe(false);
  });

  it('names the image by digest', () => {
    expect(yaml).toContain(`x-image: &image ${IMAGE}`);
    expect(yaml).not.toContain('aflow-local:dev');
  });

  it('fixes the API port, because the image has that origin baked in', () => {
    expect(yaml).not.toContain('AFLOW_API_PORT');
    expect(yaml).toContain(`127.0.0.1:${BAKED_API_PORT}:3000`);
  });

  it('leaves the web port configurable, because nothing bakes it', () => {
    expect(yaml).toContain('AFLOW_WEB_PORT');
  });

  it('keeps the topology it derives from', () => {
    for (const service of [
      'postgres:',
      'redis:',
      'migrate:',
      'bootstrap:',
      'api:',
      'worker:',
      'web:',
    ]) {
      expect(yaml, service).toContain(`\n  ${service}`);
    }
    // Compute starts with everything else: running code is one of the capabilities
    // the product is for, so the bundle carries the service rather than a way to
    // ask for it. MCP stays opt-in — it opens a port for other software to drive
    // this instance, which is a different kind of decision.
    expect(yaml).toContain('\n  compute:');
    expect(yaml, 'the compute service is gated again').not.toContain('profiles: [compute]');
    expect(yaml).toContain("profiles: ['mcp']");
  });

  it('keeps the reasoning the development file carries', () => {
    expect(yaml).toContain('the credential-encryption key, stored credentials do not decrypt.');
  });

  it('pins every image, not only the application', () => {
    // An appliance whose application is pinned by digest while its database
    // floats on a tag is not pinned: the documented `docker compose pull` can
    // replace PostgreSQL under an installed instance, and rolling back to an
    // earlier bundle does not put the previous one back.
    expect(floatingImages(source).length).toBeGreaterThan(1);
    expect(floatingImages(yaml)).toEqual([]);
  });

  it('refuses to emit anything when an image has no digest', () => {
    expect(() => consumerCompose(source, { image: IMAGE, pinned: {} })).toThrow(
      /no digest was resolved/,
    );
  });

  it('names the paths it bind-mounts from beside itself', () => {
    // These have to travel with the file. Docker creates a directory where a
    // missing bind source should be, so Postgres starts, finds no `.sql` in
    // `docker-entrypoint-initdb.d`, never creates the extensions, and the
    // first migration fails against a database that reported healthy.
    expect(relativeBindSources(yaml)).toEqual(['scripts/appliance-init-db.sql']);
  });

  it('ships no script whose default names a file only this repository has', () => {
    // The bundle carries its Compose file under the plain name, so a shipped
    // script defaulting to the development one fails on the first command a
    // collaborator is told to run. Both the smoke and the restore script had
    // that default; this is the property rather than the two instances.
    const shipped = [
      'scripts/appliance-smoke.sh',
      'scripts/appliance-restore.sh',
      'scripts/appliance-backup.sh',
    ];
    const wrong: string[] = [];
    for (const relative of shipped) {
      const path = join(repoRoot, relative);
      if (!existsSync(path)) {
        wrong.push(`${relative} is shipped in the bundle and is not in the repository`);
        continue;
      }
      const text = readFileSync(path, 'utf-8');
      if (text.includes('docker-compose.local.yml') && !text.includes('docker-compose.yml')) {
        wrong.push(`${relative} defaults to a Compose file the bundle does not carry`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('gives every workflow job that reaches the registry a package permission', () => {
    // A job's `permissions` block replaces the workflow's rather than adding
    // to it, so a job that names one permission silently loses the others.
    // That is invisible until something in the job needs the one it dropped —
    // here, pulling the private image it had just published.
    const workflow = readFileSync(join(repoRoot, '.github/workflows/appliance-image.yml'), 'utf-8');
    const jobs = workflow.split(/\n  (?=[a-z][a-z0-9-]*:\n)/).slice(1);
    expect(jobs.length).toBeGreaterThan(2);

    const wrong: string[] = [];
    for (const job of jobs) {
      const name = job.slice(0, job.indexOf(':'));
      if (!job.includes('ghcr.io')) continue;
      // Only a job that declares its own block overrides the workflow's.
      if (!/^    permissions:$/m.test(job)) continue;
      if (!/^      packages: (read|write)$/m.test(job)) {
        wrong.push(
          `${name} reaches the registry and its own permissions block names no package access`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('refuses an image that is not pinned by digest', () => {
    for (const image of [
      'aflow-local:dev',
      'ghcr.io/aflowai/aflow-appliance:v1',
      'ghcr.io/x@sha256:short',
    ]) {
      expect(() => consumerCompose(source, { image, pinned: PINNED }), image).toThrow(
        BundleTransformError,
      );
    }
  });

  it('refuses to emit a remainder when the source shape changes', () => {
    const cases: Array<[string, string]> = [
      ['the `x-image` anchor is not there', source.replace(/^x-image: &image .+$/m, '# gone')],
      [
        'the `x-build` anchor is not there',
        source.replace(/\nx-build: &build\n/, '\nx-nothing: &build\n'),
      ],
      ['no service declares', source.replace(/^[ \t]*build: \*build\n/m, '')],
    ];
    for (const [missing, mutated] of cases) {
      expect(() => consumerCompose(mutated, { image: IMAGE, pinned: PINNED }), missing).toThrow(
        missing,
      );
    }
  });
});
