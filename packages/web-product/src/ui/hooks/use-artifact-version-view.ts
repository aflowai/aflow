'use client';

import type { QueryKey } from '@tanstack/react-query';
import type { ArtifactVersionView } from '@aflow/schemas';
import { useApiQuery } from './useApiQuery.js';

/**
 * The compiled view of one artifact version.
 *
 * Keyed by version rather than by whatever is displaying it, because a version's
 * html is immutable: an applet upgrade repins the instance to a different
 * version and the key changes with it, so nothing has to be invalidated for the
 * new view to appear. Nested under the space prefix so a space switch drops it
 * with everything else.
 *
 * The response carries the html as a JSON string, never as a document — these
 * bytes are generated, and the only place they may execute is the sandboxed
 * frame the caller mounts them in.
 */
export type { ArtifactVersionView };

export function artifactVersionViewKey(spaceId: string, versionId: string): QueryKey {
  return ['space', spaceId, 'ui-artifact-view', versionId];
}

export function useArtifactVersionView(spaceId: string | undefined, versionId: string | undefined) {
  return useApiQuery<ArtifactVersionView>({
    key: artifactVersionViewKey(spaceId ?? 'none', versionId ?? 'none'),
    path: `/ui-artifacts/versions/${versionId ?? ''}/view`,
    enabled: spaceId !== undefined && versionId !== undefined,
    // The origin serves `no-cache` with a strong validator, because the view
    // pointer is rewritable — a republish or compiler change can move it. An
    // infinite window here would hold the old bytes for the tab's lifetime;
    // a finite one picks the change up, and the 304 makes the check cheap.
    staleTime: 5 * 60_000,
  });
}
