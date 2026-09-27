/**
 * The consumer form of the appliance's Compose file.
 *
 * A collaborator installs by pulling, so the file they get must describe the
 * same topology with nothing to build: no build section, and an image pinned
 * by digest rather than named by tag. Derived from the development Compose file
 * rather than maintained beside it — two files describing one topology drift,
 * and the drift surfaces as an install that works for whoever edited the copy
 * they use.
 *
 * Text, not a parsed document. The source carries the reasoning for its own
 * shape in comments and relies on YAML anchors; a round-trip through a parser
 * discards both, and the file a collaborator reads is the one place that
 * reasoning is worth the most.
 */

/** What a transform could not find, which is never a reason to carry on. */
export class BundleTransformError extends Error {
  constructor(readonly missing: string) {
    super(
      `Cannot derive the consumer Compose file: ${missing}. The development file's shape changed, ` +
        'and emitting the remainder would publish an install that still tries to build.',
    );
    this.name = 'BundleTransformError';
  }
}

/**
 * The API port is baked, and the web port is not.
 *
 * Next inlines `NEXT_PUBLIC_API_ORIGIN` into the client bundle at build time,
 * so a published image answers on whichever API origin it was built with. A
 * consumer file that offered the port as a variable would let an operator
 * change it, start cleanly, and then watch every call from the browser go to
 * an origin nothing is listening on. The web port carries no such constraint:
 * every reader of it is runtime configuration.
 */
export const BAKED_API_PORT = '3000';

export interface ConsumerComposeResult {
  yaml: string;
  /** What was removed or fixed, for the generator to report. */
  changes: string[];
}

/**
 * Image references the file names by tag rather than through the app anchor.
 *
 * An appliance whose application is pinned by digest while its database floats
 * on `pg16` is not pinned: the documented `docker compose pull` can replace
 * PostgreSQL or Redis underneath an installed instance, and a rollback to an
 * earlier bundle does not put the previous one back.
 */
export function floatingImages(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/^\s+image: (?!\*image$)(\S+)$/gm)) {
    const reference = match[1];
    if (reference !== undefined && !reference.includes('@sha256:')) found.add(reference);
  }
  return [...found].sort();
}

/**
 * Paths the file bind-mounts from beside itself.
 *
 * These travel with the Compose file or they are not there. Docker creates a
 * directory where a missing bind source should be, so the container starts and
 * the file it expected is silently an empty directory — which for
 * `docker-entrypoint-initdb.d` means the extensions are never created and the
 * first migration fails on a database that looked healthy.
 */
export function relativeBindSources(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/^\s+- (\.\/[^:]+):/gm)) {
    const path = match[1];
    if (path !== undefined) found.add(path.replace(/^\.\//, ''));
  }
  return [...found].sort();
}

export function consumerCompose(
  source: string,
  options: {
    image: string;
    /** A digest for every reference `floatingImages` finds, or this refuses. */
    pinned: Readonly<Record<string, string>>;
  },
): ConsumerComposeResult {
  if (!/^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/.test(options.image)) {
    throw new BundleTransformError(
      `the image reference "${options.image}" is not pinned by digest — a tag can move under an installed instance`,
    );
  }

  const changes: string[] = [];
  let yaml = source;

  // ── The image, named by digest ───────────────────────────────────────────
  const imageAnchor = /^x-image: &image .+$/m;
  if (!imageAnchor.test(yaml)) throw new BundleTransformError('the `x-image` anchor is not there');
  yaml = yaml.replace(imageAnchor, `x-image: &image ${options.image}`);
  changes.push(`pinned the image to ${options.image}`);

  // ── The build section, and the one service that owns it ──────────────────
  const buildAnchor = /\nx-build: &build\n(?:[ \t].*\n|\n(?=[ \t]))*/;
  if (!buildAnchor.test(yaml)) throw new BundleTransformError('the `x-build` anchor is not there');
  yaml = yaml.replace(buildAnchor, '\n');
  changes.push('removed the build definition');

  const buildUse = /^[ \t]*build: \*build\n/m;
  if (!buildUse.test(yaml)) {
    throw new BundleTransformError('no service declares `build: *build`');
  }
  yaml = yaml.replace(new RegExp(buildUse.source, 'gm'), '');
  changes.push('removed every service build section');

  // ── The baked port stops being a variable ────────────────────────────────
  const apiPortVariable = /\$\{AFLOW_API_PORT:-\d+\}/g;
  const occurrences = yaml.match(apiPortVariable);
  if (occurrences === null) {
    throw new BundleTransformError(
      '`AFLOW_API_PORT` is no longer read, so nothing pins the origin',
    );
  }
  yaml = yaml.replace(apiPortVariable, BAKED_API_PORT);
  changes.push(
    `fixed the API port at ${BAKED_API_PORT} in ${String(occurrences.length)} place(s) — the published image has that origin baked into its client bundle`,
  );

  // ── Every other image, pinned too ────────────────────────────────────────
  for (const reference of floatingImages(yaml)) {
    const digest = options.pinned[reference];
    if (digest === undefined || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new BundleTransformError(
        `no digest was resolved for "${reference}" — pinning the application while its datastore floats is not a pinned appliance`,
      );
    }
    // A literal swap. The reference came out of this same text, so escaping it
    // into a pattern only adds a way to get the escaping wrong.
    const [name] = reference.split(':');
    yaml = yaml.replace(`image: ${reference}`, `image: ${String(name)}@${digest}`);
    changes.push(`pinned ${reference} to ${digest}`);
  }

  return { yaml, changes };
}

/** Whether a derived file still describes something buildable. */
export function bundleStillBuilds(yaml: string): boolean {
  return /(^|\n)\s*build:/.test(yaml) || yaml.includes('x-build:');
}
