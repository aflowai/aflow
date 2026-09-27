/**
 * The shell's space navigation and the route manifest describe the same
 * product from two ends, and nothing made them agree.
 *
 * An application built from the manifest carries exactly the routes it names.
 * The shell links wherever its code says. While every route also existed as a
 * hand-written file under `apps/web`, the two could disagree and only the
 * hosted application would be right — which is how the local build shipped a
 * nav linking to `/integrations` and `/memory` while carrying neither.
 *
 * Presence in the manifest is not the question; presence *per edition* is. A
 * link the shell emits unconditionally must resolve in every edition that
 * shell serves, so a route narrowed to one of them recreates the same 404.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ROUTE_MANIFEST, type WebEdition } from './routeManifest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, 'components/app-shell.tsx');

/**
 * The links the shell shows only in some editions, each with the condition that
 * makes it so. The condition is checked against the source, so deleting the
 * gate fails here rather than turning the entry into a silent exemption.
 */
const GATED: ReadonlyArray<{ path: string; editions: readonly WebEdition[]; gate: string }> = [
  // A paired machine belongs to the operator running the appliance; a hosted
  // deployment has none to reach.
  { path: '/computer', editions: ['local'], gate: 'if (isLocalEdition) {' },
  // Membership is a tenant relationship, withheld with the surface that serves
  // it. The role alone does not decide — the sole owner of an appliance is
  // always its admin.
  {
    path: '/settings/members',
    editions: ['hosted'],
    gate: 'if (isSpaceAdmin && hasSpaceMembers) {',
  },
];

/**
 * Paths the shared product navigates to outright, rather than through
 * `spaceRoute`. These are the ones the space-scoped assertions above cannot
 * see, and the ones that shipped `/account` and `/spaces/archived` as links the
 * local build had nothing behind.
 */
const ROOT_PATH = '/';

/** Every module of the shared product, so a link anywhere in it is in scope. */
function sharedModules(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  return walk(HERE);
}

/** Absolute navigations: a router push/replace, or a link with a literal href. */
function absoluteNavTargets(): Array<{ path: string; file: string }> {
  const found = new Map<string, string>();
  for (const file of sharedModules()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/router\.(?:push|replace)\('(\/[^']*)'\)/g)) {
      found.set(m[1] as string, file);
    }
    for (const m of src.matchAll(/href=(?:"(\/[^"]*)"|\{'(\/[^']*)'\})/g)) {
      found.set((m[1] ?? m[2]) as string, file);
    }
  }
  return [...found].map(([path, file]) => ({ path, file: relativeToUi(file) }));
}

function relativeToUi(file: string): string {
  return file.slice(HERE.length + 1);
}

function shellSource(): string {
  return readFileSync(SHELL, 'utf8');
}

/** Every literal path the shell turns into a space-scoped link. */
function navPaths(): string[] {
  const src = shellSource();
  const found = new Set<string>();
  for (const m of src.matchAll(/spaceRoute\([^,]+,\s*'([^']+)'\)/g)) found.add(m[1] as string);
  // `spaceRoute(slug, item.path)` — the items come from the nav tuple above it.
  const table = /const navItems[^=]*=\s*\[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
  for (const entry of table.matchAll(/path:\s*'([^']+)'/g)) found.add(entry[1] as string);
  return [...found].sort();
}

/** Which editions the manifest serves a route at an absolute path in. */
function absoluteEditions(path: string): readonly WebEdition[] {
  const route = path.replace(/^\//, '');
  const entry = ROUTE_MANIFEST.find(
    (candidate) => candidate.route === route && candidate.kind !== 'layout',
  );
  return entry?.editions ?? [];
}

/** Which editions the manifest actually serves a space route in. */
function servedEditions(path: string): readonly WebEdition[] {
  const route = `s/[space]${path}`;
  const entry = ROUTE_MANIFEST.find((candidate) => candidate.route === route);
  return entry?.editions ?? [];
}

describe('space navigation', () => {
  it('links only where the manifest carries a route', () => {
    const dangling = navPaths().filter((path) => servedEditions(path).length === 0);
    expect(dangling).toEqual([]);
  });

  it('shows an ungated link only where every edition can follow it', () => {
    const gatedPaths = new Set(GATED.map((entry) => entry.path));
    const editions: readonly WebEdition[] = ['hosted', 'local'];
    const unreachable = navPaths()
      .filter((path) => !gatedPaths.has(path))
      .flatMap((path) => {
        const served = servedEditions(path);
        return editions
          .filter((edition) => !served.includes(edition))
          .map((edition) => `${path} is not served in ${edition}`);
      });
    expect(unreachable).toEqual([]);
  });

  it('keeps every gated link behind the gate that excuses it', () => {
    const src = shellSource();
    const broken = GATED.flatMap((entry) => {
      const problems: string[] = [];
      if (!src.includes(entry.gate)) problems.push(`${entry.path}: gate \`${entry.gate}\` is gone`);
      const served = servedEditions(entry.path);
      const missing = entry.editions.filter((edition) => !served.includes(edition));
      if (missing.length > 0) {
        problems.push(`${entry.path} is gated to ${entry.editions.join('/')} but served in none`);
      }
      // A link the manifest serves everywhere does not need a gate, and a gate
      // that outlives its reason hides the route from an edition that has it.
      const surplus = served.filter((edition) => !entry.editions.includes(edition));
      if (surplus.length > 0) {
        problems.push(`${entry.path} is served in ${surplus.join('/')} the gate withholds`);
      }
      return problems;
    });
    expect(broken).toEqual([]);
  });

  /**
   * `useEdition` answers `null` until the server does, so a gate that shows a
   * link UNLESS something is true is open for as long as that takes. The link
   * renders, Next prefetches it, and a build that does not serve the route
   * answers 404 — invisible on the page and visible in every console.
   *
   * Stated as the property rather than as the spellings of a negation, which
   * `!isHostedEdition`, `!isLocal` and `edition.id !== 'enterprise'` already show
   * is a list with no end: a gate carrying any negation has to name the edition
   * it is recorded for, positively, somewhere in the same condition. A gate with
   * no negation is left alone — `/settings/members` turns on a fail-closed
   * surface check, which is already closed while the answer is pending.
   */
  const NAMES_EDITION: Record<WebEdition, RegExp> = {
    local: /isLocalEdition|'community-local'/,
    hosted: /isHostedEdition|'enterprise'/,
  };

  /** Any mention of an edition, however it is spelled. */
  const MENTIONS_EDITION = /[Ee]dition|'enterprise'|'community-local'/;

  function openWhileUnknown(gate: string, editions: readonly WebEdition[]): boolean {
    // A gate that speaks of editions, or withholds on a negation, has to say
    // which edition it is for. One that does neither turns on something else,
    // and that mechanism's own default is its business.
    if (!MENTIONS_EDITION.test(gate) && !gate.includes('!')) return false;
    return !editions.every((edition) => NAMES_EDITION[edition].test(gate));
  }

  it('gates an edition-specific link on the edition it belongs to', () => {
    const inverted = GATED.filter((entry) => openWhileUnknown(entry.gate, entry.editions)).map(
      (entry) => `${entry.path}: \`${entry.gate}\` is open while the edition is unknown`,
    );
    expect(inverted).toEqual([]);
  });

  it('recognises an open gate however the negation is written', () => {
    // The assertion above is empty on a clean table, so it would pass with a
    // check that recognises nothing.
    const open = [
      'if (!isHostedEdition) {',
      "if (edition.id !== 'enterprise') {",
      'if (isHostedEdition === false) {',
      "if (!(edition.id === 'enterprise')) {",
      'if (!isLocal) {',
    ];
    expect(open.filter((gate) => !openWhileUnknown(gate, ['local']))).toEqual([]);

    // And a gate that names its edition is closed while unknown, negation or not.
    expect(openWhileUnknown('if (isLocalEdition) {', ['local'])).toBe(false);
    expect(openWhileUnknown('if (!isLoading && isLocalEdition) {', ['local'])).toBe(false);
    expect(openWhileUnknown('if (isSpaceAdmin && hasSpaceMembers) {', ['hosted'])).toBe(false);
  });

  it('navigates outright only where the manifest carries a route', () => {
    const dangling = absoluteNavTargets()
      // The application root is each application's own page, not a generated one.
      .filter((target) => target.path !== ROOT_PATH)
      .filter((target) => absoluteEditions(target.path).length === 0)
      .map((target) => `${target.file} -> ${target.path}`);
    expect(dangling).toEqual([]);
  });

  it('navigates outright only where every edition can follow', () => {
    const editions: readonly WebEdition[] = ['hosted', 'local'];
    const gatedPaths = new Set(GATED.map((entry) => entry.path));
    const unreachable = absoluteNavTargets()
      .filter((target) => target.path !== ROOT_PATH && !gatedPaths.has(target.path))
      .flatMap((target) => {
        const served = absoluteEditions(target.path);
        if (served.length === 0) return [];
        return editions
          .filter((edition) => !served.includes(edition))
          .map((edition) => `${target.file} -> ${target.path} is not served in ${edition}`);
      });
    expect(unreachable).toEqual([]);
  });

  /**
   * Every assertion above reads the literal the shell hands `spaceRoute`, which
   * only describes a link once a slug exists. Without one `spaceRoute` returns
   * the path unchanged, and the unscoped forms — `/store`, `/triggers`,
   * `/computer`, `/skills`, `/settings/general` — have no page in either
   * edition. A tenant-level page carries no route slug at all, so this is not
   * merely the first render of a space page.
   */
  it('emits no space navigation before a space resolves', () => {
    const src = shellSource();
    expect(src).toContain('if (slug === undefined) return null;');
  });

  it('finds the shell where it expects to', () => {
    // The regexes above fail open if the file moves or the helper is renamed:
    // no matches means no assertions rather than a failure.
    expect(navPaths().length).toBeGreaterThan(7);
  });
});
