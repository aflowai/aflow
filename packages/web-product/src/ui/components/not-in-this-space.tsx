'use client';

import { useRouter } from 'next/navigation';
import { Button, Column, Icon, Text } from '@aflow/design-system';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { useSpace } from './providers.js';

export interface NotInThisSpaceProps {
  /** What kind of resource the URL referenced — drives copy + the `where-is` query. */
  resourceKind: 'agent';
  /** The unresolvable slug from the URL. */
  resourceSlug: string;
  /** The space slug the user is currently inside (where the resource is missing). */
  currentSpaceSlug: string;
  /** Optional label shown above the resource slug, e.g. "Agent". Defaults to a sensible kind label. */
  resourceLabel?: string;
}

interface WhereIsHit {
  spaceId: string;
  spaceSlug: string;
  spaceName: string;
}
interface WhereIsResponse {
  hits: WhereIsHit[];
}

const KIND_LABEL: Record<NotInThisSpaceProps['resourceKind'], string> = {
  agent: 'Agent',
};

function resourcePath(kind: NotInThisSpaceProps['resourceKind'], slug: string): string {
  switch (kind) {
    case 'agent':
      return `agents/${encodeURIComponent(slug)}`;
  }
}

export function NotInThisSpace({
  resourceKind,
  resourceSlug,
  currentSpaceSlug,
  resourceLabel,
}: NotInThisSpaceProps) {
  const router = useRouter();
  const { spaces } = useSpace();

  const query = useApiQuery<WhereIsResponse>({
    key: ['spaces', 'where-is', resourceKind, resourceSlug],
    path: `/spaces/where-is?resourceKind=${encodeURIComponent(resourceKind)}&slug=${encodeURIComponent(
      resourceSlug,
    )}`,
    // Where-is depends on which spaces the user can access — refetch
    // when membership changes (handled implicitly by the spaces list
    // refetch) rather than caching forever.
    staleTime: 30_000,
  });

  const allHits = query.data?.hits ?? [];
  // Filter out the current space defensively. The server's `where-is`
  // only returns spaces with a live agent of that slug, so the current
  // space is normally absent already; but it's possible to land here
  // with a stale URL right after a rename in the current space — in
  // which case the redirect path on `GET /agents/:slug` handles it,
  // and `where-is` returns no current-space hit anyway.
  const hits = allHits.filter((h) => h.spaceSlug !== currentSpaceSlug);

  const label = resourceLabel ?? KIND_LABEL[resourceKind];
  const currentSpaceName =
    spaces.find((s) => s.slug === currentSpaceSlug)?.name ?? currentSpaceSlug;

  return (
    <Column
      align="center"
      gap="4"
      style={{
        flex: 1,
        padding: 'var(--space-6)',
        maxWidth: 520,
        margin: '0 auto',
        textAlign: 'center',
      }}
    >
      <Icon name="warning-circle" size="lg" />
      <Text size="lg" weight="medium">
        This {label.toLowerCase()} isn’t in {currentSpaceName}
      </Text>
      <Text size="sm" variant="muted">
        <code>{resourceSlug}</code> doesn’t exist in this space.
      </Text>

      {query.isLoading ? (
        <Text size="sm" variant="muted">
          Looking elsewhere…
        </Text>
      ) : hits.length === 0 ? (
        <Column gap="2" align="center">
          <Text size="sm" variant="muted">
            Not visible in any space you have access to.
          </Text>
          <Button
            variant="secondary"
            onClick={() => {
              router.push(`/s/${encodeURIComponent(currentSpaceSlug)}/${resourceKind}s`);
            }}
          >
            Back to {label.toLowerCase()} list
          </Button>
        </Column>
      ) : (
        <Column gap="2" align="stretch" style={{ width: '100%' }}>
          <Text size="sm" variant="muted">
            Found in:
          </Text>
          {hits.map((hit) => (
            <Button
              key={hit.spaceId}
              variant="primary"
              onClick={() => {
                router.push(
                  `/s/${encodeURIComponent(hit.spaceSlug)}/${resourcePath(resourceKind, resourceSlug)}`,
                );
              }}
            >
              Open in {hit.spaceName}
            </Button>
          ))}
          <Button
            variant="secondary"
            onClick={() => {
              router.push(`/s/${encodeURIComponent(currentSpaceSlug)}/${resourceKind}s`);
            }}
          >
            Back to {label.toLowerCase()} list in {currentSpaceName}
          </Button>
        </Column>
      )}
    </Column>
  );
}
