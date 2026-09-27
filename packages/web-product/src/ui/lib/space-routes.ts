export function spaceRoute(spaceSlug: string | undefined, path: string): string {
  if (!spaceSlug) return path;
  const qIndex = path.indexOf('?');
  const pathname = qIndex >= 0 ? path.slice(0, qIndex) : path;
  const query = qIndex >= 0 ? path.slice(qIndex) : '';
  const rest = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return `/s/${encodeURIComponent(spaceSlug)}/${rest}${query}`;
}

const SPACE_PATH_PREFIX = /^\/s\/([^/]+)(\/.*)?$/;
const RESOURCE_TRUNCATE_SEGMENTS: ReadonlySet<string> = new Set([
  'agents',
  'sessions',
  'memory',
  'integrations',
]);

export function equivalentRouteInSpace(currentPath: string, newSpaceSlug: string): string {
  const trimmed = stripQuery(currentPath);
  const match = SPACE_PATH_PREFIX.exec(trimmed);
  if (!match) {
    // Not currently on a space-scoped URL — drop the user on the new
    // space's canonical landing (`/chat`). The caller can layer
    // query-preservation later if needed.
    return `/s/${encodeURIComponent(newSpaceSlug)}/chat`;
  }

  const innerPath = match[2] ?? '/';
  const segments = innerPath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    return `/s/${encodeURIComponent(newSpaceSlug)}/chat`;
  }

  // Walk segment-by-segment; stop the first time we step **into** a
  // dynamic position under a resource list (e.g. into `<agentSlug>`
  // after `agents`). The result is the deepest URL guaranteed to render.
  const kept: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    const previous = segments[i - 1];

    // Stop the first time we cross into a per-resource segment.
    if (previous && RESOURCE_TRUNCATE_SEGMENTS.has(previous)) break;
    if (previous === 'skills') break;

    kept.push(segment);
  }

  const tail = kept.join('/');
  return tail.length > 0
    ? `/s/${encodeURIComponent(newSpaceSlug)}/${tail}`
    : `/s/${encodeURIComponent(newSpaceSlug)}/chat`;
}

function stripQuery(path: string): string {
  const q = path.indexOf('?');
  return q >= 0 ? path.slice(0, q) : path;
}

/** Resolve a space UUID to its slug for URL construction. */
export function resolveSpaceSlug(
  spaces: ReadonlyArray<{ id: string; slug: string }>,
  spaceId: string,
  activeSpace: { id: string; slug: string } | null,
): string | undefined {
  if (activeSpace?.id === spaceId) return activeSpace.slug;
  return spaces.find((s) => s.id === spaceId)?.slug;
}
