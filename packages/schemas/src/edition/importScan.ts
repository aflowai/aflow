/**
 * Which files import which package.
 *
 * Shared between the cut and the guard that reports what it would drop, so the
 * two cannot disagree about what "nothing imports this any more" means. Bare
 * specifiers only — a relative import names a file, and `coreCutCoherence`
 * already answers for those.
 */

const SPECIFIER =
  /(?:from\s*['"]|import\s*\(\s*['"]|require\s*\(\s*['"]|import\s+['"])([^.'"][^'"]*)['"]/g;

/** The package a bare specifier belongs to, scope included. */
export function packageOfSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('node:') || specifier.startsWith('.')) return undefined;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return name === undefined || name === '' ? undefined : name;
}

/**
 * Package → the files importing it.
 *
 * `read` is passed in rather than taken here so the caller decides what tree is
 * being described — the repository, or a cut of it.
 */
export function buildImporterIndex(
  files: Iterable<string>,
  read: (path: string) => string,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    for (const match of read(file).matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const name = packageOfSpecifier(specifier);
      if (name === undefined) continue;
      const seen = index.get(name);
      if (seen === undefined) index.set(name, [file]);
      else if (!seen.includes(file)) seen.push(file);
    }
  }
  return index;
}
