import type { PlanNodeLink, PlanNodeLinkKind } from '@aflow/schemas';
import { spaceRoute } from './space-routes.js';

/** Where a link leads: a page of this product, another site, or nowhere a page shows. */
export type PlanLinkTarget =
  { kind: 'internal'; href: string } | { kind: 'external'; href: string } | { kind: 'none' };

export const PLAN_LINK_KIND_LABEL: Record<PlanNodeLinkKind, string> = {
  run: 'run',
  session: 'conversation',
  pull_request: 'pull request',
  document: 'document',
  finding: 'finding',
  campaign: 'campaign',
  merge: 'merge',
};

const WEB_URL = /^https?:\/\//;

function memoryHref(spaceSlug: string, path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  return spaceRoute(spaceSlug, `/memory/${segments.map(encodeURIComponent).join('/')}`);
}

/**
 * A run and a conversation open their own pages, a pull request or a merge its
 * URL, and a document its memory path or URL. A finding is named by its own
 * text and a campaign by an id no page here is addressed by, so neither leads
 * anywhere.
 */
export function planLinkTarget(link: PlanNodeLink, spaceSlug: string): PlanLinkTarget {
  switch (link.kind) {
    case 'run':
      return {
        kind: 'internal',
        href: spaceRoute(spaceSlug, `/runs/${encodeURIComponent(link.ref)}`),
      };
    case 'session':
      return {
        kind: 'internal',
        href: spaceRoute(spaceSlug, `/sessions/${encodeURIComponent(link.ref)}`),
      };
    case 'pull_request':
    case 'merge':
      return WEB_URL.test(link.ref) ? { kind: 'external', href: link.ref } : { kind: 'none' };
    case 'document':
      if (WEB_URL.test(link.ref)) return { kind: 'external', href: link.ref };
      return link.ref.startsWith('/')
        ? { kind: 'internal', href: memoryHref(spaceSlug, link.ref) }
        : { kind: 'none' };
    case 'finding':
    case 'campaign':
      return { kind: 'none' };
  }
}

const PULL_REQUEST_URL = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/**
 * What a link reads as: a pull request or merge as `repo#number`, anything
 * else by its label, else its ref. A pull request's label says where it came
 * from, which is the detail, not the name.
 */
export function planLinkText(link: PlanNodeLink): string {
  const pr = PULL_REQUEST_URL.exec(link.ref);
  if (pr && (link.kind === 'pull_request' || link.kind === 'merge')) {
    return `${pr[2] ?? ''}#${pr[3] ?? ''}`;
  }
  return link.label ?? link.ref;
}
