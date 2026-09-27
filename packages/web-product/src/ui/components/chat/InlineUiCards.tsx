'use client';

import { useApi } from '../providers.js';
import { useArtifactVersionView } from '../../hooks/use-artifact-version-view.js';
import { ArtifactRenderer, ARTIFACT_MIN_HEIGHT } from '../artifact-renderer.js';
import { AppletInstanceView } from '../applet-instance-view.js';
import { SurfaceRenderer } from '../surface-renderer/index.js';
import { MountWhenNear } from '../mount-when-near.js';
import type { SurfaceMutation } from '@aflow/schemas';
import { Row, Spinner, Text } from '@aflow/design-system';

export interface InlineArtifactCardItem {
  itemId: string;
  artifactId: string;
  versionId: string;
  data?: unknown;
}

export function InlineArtifactCard({ item }: { item: InlineArtifactCardItem }) {
  const { spaceId } = useApi();
  // The same view the applet surface mounts, fetched the same way: by version,
  // from the surface that owns it, rather than by a storage address the card
  // was handed.
  const view = useArtifactVersionView(spaceId ?? undefined, item.versionId);
  const html = view.data?.html ?? null;
  // A null space disables the query, which reports neither data nor error —
  // rendered as loading, that state never ends.
  const err =
    view.error !== null
      ? (view.error?.message ?? null)
      : spaceId === null
        ? 'This artifact needs an active space to load from.'
        : null;

  if (err !== null) {
    return (
      <Row gap="2" style={{ padding: 'var(--space-3) var(--space-5)' }}>
        <Text variant="muted" size="sm">
          Inline artifact unavailable ({err}).
        </Text>
      </Row>
    );
  }
  if (html === null) {
    return (
      <Row gap="2" style={{ padding: 'var(--space-3) var(--space-5)' }}>
        <Spinner size="sm" />
        <Text variant="muted" size="sm">
          Loading artifact…
        </Text>
      </Row>
    );
  }
  return (
    <div style={{ padding: 'var(--space-3) var(--space-5)' }}>
      {/* Rebuilt from `html` every time it mounts, so scrolling past it costs
          nothing to restore. `ARTIFACT_MIN_HEIGHT` is what the renderer itself
          starts at. */}
      <MountWhenNear reserve={ARTIFACT_MIN_HEIGHT}>
        <ArtifactRenderer
          html={html}
          {...(typeof item.data === 'object' && item.data !== null && !Array.isArray(item.data)
            ? { data: item.data as Record<string, unknown> }
            : {})}
          metadata={{ artifactId: item.artifactId, versionId: item.versionId }}
        />
      </MountWhenNear>
    </div>
  );
}

export interface InlineAppletCardItem {
  itemId: string;
  instanceId: string;
}

/**
 * The board, mounted where the step that last referenced it landed.
 *
 * One card per instance, moved rather than copied, so a session that reads the
 * applet on every turn shows one board and not a history of them. While it is
 * the staged instance the stream renders a chip in its place instead — the
 * picture lives on the stage.
 */
export function InlineAppletCard({
  item,
  spaceId,
}: {
  item: InlineAppletCardItem;
  spaceId: string | undefined;
}) {
  return (
    <div style={{ padding: 'var(--space-3) var(--space-5)', maxWidth: '100%' }}>
      <AppletInstanceView spaceId={spaceId} instanceId={item.instanceId} />
    </div>
  );
}

export interface InlineSurfaceCardItem {
  itemId: string;
  surfaceId: string;
  isStreaming: boolean;
  mutations: Array<Record<string, unknown>>;
}

/**
 * Phase 2.5 — replay the accumulated mutation stream through
 * `<SurfaceRenderer>`. The reducer accumulates mutations as
 * `WorkflowTaskSurfaceUpdate` events arrive (workflow-task path); this
 * card reads them from the inline item and paints via the existing
 * surface engine. When the batch contains `completeSurface`, the
 * reducer flips `isStreaming` to false and the spinner disappears.
 *
 * The session-scoped Helmsman path still has a parallel renderer in
 * the reducer's `SurfaceUpdate` → message pipeline (mounts a surface
 * message bubble in `next.messages`). That path keeps painting; this
 * card is the inline-item equivalent for the workflow-task path AND
 * for any future session-scoped surface op that emits `presentation:
 * rendered_inline` (e.g. ad-hoc Helmsman `ui.surface.visualize` once
 * Phase 4 lands).
 */
export function InlineSurfaceCard({ item }: { item: InlineSurfaceCardItem }) {
  // SurfaceMutation is the schema-validated shape; the reducer stores
  // mutations as opaque records (cross-package dep avoidance). Cast at
  // render time — the producer side already validated.
  const mutations = item.mutations as unknown as SurfaceMutation[];
  if (mutations.length === 0) {
    return (
      <Row gap="2" style={{ padding: 'var(--space-3) var(--space-5)' }}>
        {item.isStreaming ? <Spinner size="sm" /> : null}
        <Text variant="muted" size="sm">
          {item.isStreaming
            ? `Starting surface ${item.surfaceId}…`
            : `Surface ${item.surfaceId} (no mutations)`}
        </Text>
      </Row>
    );
  }
  return (
    <div style={{ padding: 'var(--space-3) var(--space-5)' }}>
      <SurfaceRenderer mutations={mutations} showLoading={item.isStreaming} />
    </div>
  );
}
