/**
 * What the cut does to a file it keeps.
 *
 * Deleting the files is only half of the transformation. A tsconfig project
 * reference, a package script and a Docker COPY all name paths, and a tree
 * that dropped the path but kept the reference cannot build for a reason
 * nothing in the manifest describes.
 *
 * These live here rather than in `scripts/core-cut.mjs` so the guard that says
 * a reference is acceptable and the script that makes it acceptable are the
 * same code. Two descriptions of one transformation drift, and the one that
 * drifts silently is the guard.
 */

/** The workspace a path belongs to, if it belongs to one. */
export function workspaceOf(path: string): string | undefined {
  return /^((?:apps|packages)\/[^/]+)\//.exec(path)?.[1];
}

/**
 * Root `package.json` scripts, minus every script whose command names a path the
 * cut deletes or a workspace it removes. A public core would not carry
 * `gcp:deploy` with no deploy script behind it, nor `web:dev` with no
 * `@aflow/web` to run.
 *
 * Both halves are needed because a command names its target either way:
 * `tsx scripts/gcp-deploy.ts` by path, `yarn workspace @aflow/web dev` by
 * workspace. Matching only paths leaves the second kind pointing at nothing,
 * which fails as an opaque Yarn error rather than an absent script.
 */
export function pruneScripts(
  scripts: Readonly<Record<string, string>>,
  removedPaths: Iterable<string>,
  removedWorkspaces: Iterable<string> = [],
): { kept: Record<string, string>; dropped: string[] } {
  const removed = [...removedPaths];
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  // Matched at a path boundary. A bare `includes` would drop a script naming
  // `scripts/gcp-worker.sh.bak` because `scripts/gcp-worker.sh` went — the
  // removed path is a prefix of a kept one, and prefixes are how paths are
  // spelled.
  const names = (command: string, path: string): boolean => {
    let from = command.indexOf(path);
    while (from !== -1) {
      const after = command[from + path.length];
      if (after === undefined || !/[A-Za-z0-9._/-]/.test(after)) return true;
      from = command.indexOf(path, from + 1);
    }
    return false;
  };
  const workspaces = [...removedWorkspaces];
  for (const [name, command] of Object.entries(scripts)) {
    const namesRemoved =
      removed.some((path) => names(command, path)) ||
      workspaces.some((workspace) => names(command, workspace));
    if (namesRemoved) dropped.push(name);
    else kept[name] = command;
  }
  return { kept, dropped };
}

/**
 * `.env.example`, minus the keys this edition has no way to use.
 *
 * Not cosmetic: the server refuses to start when identity-provider configuration
 * is present and the build composes no provider, so shipping the hosted keys in
 * the template makes `cp .env.example .env` the first step of a failed first run.
 *
 * A section whose every key is cloud-owned goes whole, header and comments with
 * it; a mixed section keeps its prose and loses the individual lines. Sections
 * are the `# ===` banners the file already uses.
 */
export function pruneEnvExample(
  source: string,
  ownerOfKey: (key: string) => string | undefined,
): { kept: string; droppedKeys: string[]; droppedSections: string[] } {
  const lines = source.split('\n');
  const isBanner = (line: string): boolean => /^#\s*={5,}/.test(line);
  const keyOf = (line: string): string | undefined =>
    /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];

  // Section boundaries: a banner, the title line, and a banner again.
  const sections: Array<{ from: number; to: number; title: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBanner(lines[i] ?? '')) continue;
    if (!isBanner(lines[i + 2] ?? '')) continue;
    const from = i;
    let to = lines.length;
    for (let j = i + 3; j < lines.length; j += 1) {
      if (isBanner(lines[j] ?? '') && isBanner(lines[j + 2] ?? '')) {
        to = j;
        break;
      }
    }
    sections.push({ from, to, title: (lines[i + 1] ?? '').replace(/^#\s*/, '').trim() });
    i = to - 1;
  }

  const drop = new Set<number>();
  const droppedKeys: string[] = [];
  const droppedSections: string[] = [];

  for (const section of sections) {
    const keys: Array<{ line: number; key: string }> = [];
    for (let i = section.from; i < section.to; i += 1) {
      const key = keyOf(lines[i] ?? '');
      if (key !== undefined) keys.push({ line: i, key });
    }
    if (keys.length === 0) continue;
    if (keys.every(({ key }) => ownerOfKey(key) === 'cloud')) {
      for (let i = section.from; i < section.to; i += 1) drop.add(i);
      droppedSections.push(section.title);
      droppedKeys.push(...keys.map(({ key }) => key));
      continue;
    }
    for (const { line, key } of keys) {
      if (ownerOfKey(key) !== 'cloud') continue;
      drop.add(line);
      droppedKeys.push(key);
      // The comment run directly above documents this key and nothing else, so
      // leaving it behind turns the section into prose about absent settings.
      for (let above = line - 1; above > section.from + 2; above -= 1) {
        const text = lines[above] ?? '';
        if (!/^\s*#/.test(text) || isBanner(text)) break;
        if (keyOf(text) !== undefined) break;
        drop.add(above);
      }
    }
  }

  const kept = lines
    .filter((_, i) => !drop.has(i))
    .join('\n')
    // Three or more blank lines where a section was removed read as damage.
    .replace(/\n{4,}/g, '\n\n\n');
  return { kept, droppedKeys, droppedSections };
}

/**
 * Dockerfile lines, minus every COPY that names only workspaces the cut
 * deletes.
 *
 * A COPY is dropped whole, so one naming both a removed and a surviving path
 * would take the surviving one with it. Such a line is left in place and
 * reported instead: the build fails loudly on the missing source, which is a
 * better outcome than an image quietly missing a workspace it needs.
 */
export function pruneDockerfile(
  source: string,
  removedWorkspaces: Iterable<string>,
): { kept: string; dropped: number; mixed: string[] } {
  const workspaces = [...removedWorkspaces];
  const lines = source.split('\n');
  const mixed: string[] = [];
  const keptLines = lines.filter((line) => {
    if (!line.startsWith('COPY')) return true;
    if (!workspaces.some((workspace) => line.includes(`${workspace}/`))) return true;
    const paths = [...line.matchAll(/(?:apps|packages)\/[A-Za-z0-9._/-]+/g)].map((m) => m[0]);
    const survivors = paths.filter(
      (path) => !workspaces.some((workspace) => path.startsWith(`${workspace}/`)),
    );
    if (survivors.length > 0) {
      mixed.push(line);
      return true;
    }
    return false;
  });
  return { kept: keptLines.join('\n'), dropped: lines.length - keptLines.length, mixed };
}

/**
 * Declared dependencies no surviving file imports any more.
 *
 * A workspace is shared between editions, so its manifest lists what BOTH need:
 * `apps/server` depends on `livekit-server-sdk` for one cloud route and on
 * `nodemailer` for one cloud mailer. Delete those files and the dependency is
 * still installed — a public core shipping a realtime-video SDK nothing in it
 * imports. An import graph cannot see this; only the manifest can.
 *
 * Conservative in the safe direction: a dependency with NO direct importer is
 * kept. Build tooling, ambient types, a peer another package resolves and a
 * module loaded by configuration all look identical from here, and dropping one
 * breaks a build for a reason nothing explains. Only a dependency that is
 * imported, and imported solely by files the cut deletes, is dropped.
 */
export function dependenciesWithoutSurvivingImporter(
  declared: Iterable<string>,
  importers: ReadonlyMap<string, readonly string[]>,
  survives: (path: string) => boolean,
): string[] {
  const dropped: string[] = [];
  for (const dependency of declared) {
    // Workspace dependencies are `ownershipClosure`'s question, and it asks it
    // of the manifest rather than of the import graph.
    if (dependency.startsWith('@aflow/')) continue;
    const seen = importers.get(dependency) ?? [];
    if (seen.length === 0) continue;
    if (!seen.some(survives)) dropped.push(dependency);
  }
  // `@types/x` is never imported by name, so it has no importer to judge by.
  // It follows the package it describes: keeping it would leave the core
  // declaring types for something it no longer depends on.
  const companions = [...declared].filter(
    (dependency) =>
      dependency.startsWith('@types/') &&
      dropped.includes(dependency.slice('@types/'.length).replace(/__/g, '/')),
  );
  return [...dropped, ...companions].sort();
}

/**
 * What a surviving workspace's own manifest may no longer say.
 *
 * A subpath in `exports` names a module through its `ts-source` condition, and
 * that is neither an import nor a repo-relative path — so the import guards do
 * not see it and the config guard's extractor does not either.
 *
 * `packages/oauth` published `./auth0-management` after the cut removed
 * `src/auth0Management.ts`. The build did not fail, because a bundler skips an
 * entry it cannot find, so the cut produced a package whose `exports` map
 * pointed at files that were never written. Nothing in the cut imports that
 * subpath, which is the only reason it was inert rather than broken.
 *
 * **Scripts are reported and not rewritten.** Dropping the arguments that name
 * removed files looked like the matching fix and is wrong: `apps/server` starts
 * `"$([ -f dist/index.hosted.js ] && echo dist/index.hosted.js || echo dist/index.js)"`,
 * whose entire purpose is to name a path that is sometimes absent. Editing it
 * yields `[ -f ]` and an appliance that starts nothing — and neither install
 * nor typecheck runs a start script, so the cut would have stayed green.
 */
export function pruneWorkspaceManifest(
  manifest: Readonly<Record<string, unknown>>,
  workspaceDir: string,
  removedPaths: Iterable<string>,
): {
  manifest: Record<string, unknown>;
  droppedExports: string[];
  /** Reported so they are visible in the cut's log. Never rewritten. */
  scriptsNamingRemoved: Array<{ script: string; argument: string }>;
} {
  const removed = new Set(removedPaths);

  /** Whether a manifest-relative reference names something the cut removed. */
  const namesRemoved = (value: string): boolean => {
    const relative = value.replace(/^\.\//, '');
    if (removed.has(`${workspaceDir}/${relative}`)) return true;
    // A published condition names build output, which is untracked — so the
    // question it stands for is whether the source behind it survived.
    const asSource = relative.replace(/^dist\//, 'src/').replace(/\.(?:d\.ts|cjs|mjs|js)$/, '.ts');
    return removed.has(`${workspaceDir}/${asSource}`);
  };

  const anyStringNamesRemoved = (value: unknown): boolean => {
    if (typeof value === 'string') return namesRemoved(value);
    if (Array.isArray(value)) return value.some(anyStringNamesRemoved);
    if (value !== null && typeof value === 'object') {
      return Object.values(value).some(anyStringNamesRemoved);
    }
    return false;
  };

  const next: Record<string, unknown> = { ...manifest };
  const droppedExports: string[] = [];
  const scriptsNamingRemoved: Array<{ script: string; argument: string }> = [];

  const exportsMap = manifest['exports'];
  if (exportsMap !== null && typeof exportsMap === 'object' && !Array.isArray(exportsMap)) {
    const kept: Record<string, unknown> = {};
    for (const [subpath, target] of Object.entries(exportsMap)) {
      // The root entry is the package itself. A cut that removed it removed
      // the workspace, and this manifest would not be here to ask.
      if (subpath !== '.' && anyStringNamesRemoved(target)) {
        droppedExports.push(subpath);
        continue;
      }
      kept[subpath] = target;
    }
    if (droppedExports.length > 0) next['exports'] = kept;
  }

  const scripts = manifest['scripts'];
  if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== 'string') continue;
      for (const token of new Set(command.split(/\s+/))) {
        if (namesRemoved(token)) scriptsNamingRemoved.push({ script: name, argument: token });
      }
    }
  }

  return { manifest: next, droppedExports, scriptsNamingRemoved };
}
