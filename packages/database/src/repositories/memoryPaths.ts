import { APPLET_MEMORY_PREFIX } from '@aflow/schemas';

/**
 * Canonicalize a memory path or path prefix.
 * - Ensures leading /
 * - Collapses consecutive slashes
 * - Resolves . and .. segments
 * - Strips trailing slash (except root /)
 */
export function canonicalizePath(raw: string): string {
  if (!raw) return '/';
  let p = raw.startsWith('/') ? raw : `/${raw}`;
  p = p.replace(/\/+/g, '/');

  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') {
      parts.pop();
    } else if (seg !== '.' && seg !== '') {
      parts.push(seg);
    }
  }
  const result = `/${parts.join('/')}`;
  return result === '' ? '/' : result;
}

/** True when a canonicalized path lives in the reserved applet-state subtree. */
export function isAppletReservedPath(path: string): boolean {
  return canonicalizePath(path).startsWith(APPLET_MEMORY_PREFIX);
}

/**
 * True when a browse pathPrefix explicitly aims at or inside the reserved
 * applet-state subtree — the only way listings/search surface those docs.
 */
export function targetsAppletReservedSubtree(pathPrefix: string): boolean {
  const canonical = canonicalizePath(pathPrefix);
  return canonical + '/' === APPLET_MEMORY_PREFIX || canonical.startsWith(APPLET_MEMORY_PREFIX);
}
