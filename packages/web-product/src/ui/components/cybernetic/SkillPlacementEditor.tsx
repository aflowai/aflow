'use client';
import { useState } from 'react';
import { Button, Column, Input, Row, Text } from '@aflow/design-system';
import type { CapabilityPlacement, SkillDiscoveryEntry } from '@aflow/schemas';
import { skillPlacement, skillAwarenessTokens, SKILL_AWARENESS_TOKEN_BUDGET } from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { PlacementSelect } from './surfaceRow.js';
import { PlacementSection, placementLabels } from './PlacementSection.js';

export function SkillPlacementEditor({
  spaceId,
  placements,
  onPlace,
}: {
  spaceId: string;
  placements: Record<string, CapabilityPlacement>;
  onPlace: (slug: string, placement: CapabilityPlacement | undefined) => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const result = useApiQuery<{ skills: SkillDiscoveryEntry[]; total: number; nextCursor?: string }>(
    {
      key: ['space', spaceId, 'skills', 'discovery', query, cursor],
      spaceId,
      path: `/spaces/${spaceId}/skills/discovery?query=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    },
  );
  const entries = result.data?.skills ?? [];
  const nextCursor = result.data?.nextCursor;
  const visiblePinnedTokens = skillAwarenessTokens(
    entries.filter((s) => skillPlacement(s.slug, placements) === 'always_on'),
  );
  return (
    <Column gap="sm">
      <Text size="sm" weight="semibold">
        Skills · {result.data?.total ?? '…'} {query.trim() ? 'matching' : 'installed'}
      </Text>
      <Text size="xs" variant="muted">
        Always on loads an activation summary. On demand keeps skills searchable. Off hides skills
        from Helmsman; direct invocation, schedules and dependencies still work.
      </Text>
      <Input
        type="search"
        aria-label="Search installed skills"
        placeholder="Search installed skills…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(undefined);
        }}
      />
      {result.isError && <Text size="xs">Couldn’t load skills: {result.error.message}</Text>}
      {result.isLoading && <Text size="xs">Loading skills…</Text>}
      {(nextCursor || cursor) && (
        <Text size="xs" variant="muted">
          Placement counts below cover this results page.
        </Text>
      )}
      {(['always_on', 'on_demand', 'off'] as const).map((state) => {
        const grouped = entries.filter((entry) => skillPlacement(entry.slug, placements) === state);
        if (query.trim() && !grouped.length) return null;
        return (
          <PlacementSection
            key={`${state}-${query}-${cursor ?? ''}`}
            title={placementLabels[state]}
            count={grouped.length}
            countLabel="skills"
            forceOpen={query.trim().length > 0}
            description={
              nextCursor || cursor
                ? 'Skills on this results page.'
                : 'Installed skills with this placement.'
            }
          >
            {grouped.map((entry) => (
              <div
                key={entry.slug}
                style={{
                  padding: 'var(--space-2) 0',
                  borderTop: '1px solid var(--color-border-subtle)',
                }}
              >
                <Row align="center" gap="2">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text as="div" size="sm" style={{ overflowWrap: 'anywhere' }}>
                      {entry.name}
                    </Text>
                    <Text as="div" size="xs" variant="muted">
                      {entry.status} · ~{skillAwarenessTokens([entry])} summary tok
                    </Text>
                  </div>
                  <PlacementSelect
                    ariaLabel={`${entry.name} skill placement`}
                    value={placements[entry.slug] ?? 'default'}
                    options={[
                      { value: 'default', label: 'On demand · default' },
                      { value: 'always_on', label: 'Always on' },
                      { value: 'on_demand', label: 'On demand' },
                      { value: 'off', label: 'Off' },
                    ]}
                    onChange={(value) => {
                      onPlace(entry.slug, value === 'default' ? undefined : value);
                    }}
                  />
                </Row>
                <details>
                  <summary>
                    <Text as="span" size="xs" variant="muted">
                      When to use
                    </Text>
                  </summary>
                  <Text size="xs" variant="muted">
                    {entry.description}
                  </Text>
                </details>
              </div>
            ))}
          </PlacementSection>
        );
      })}
      {!result.isLoading && !result.isError && !entries.length && (
        <Text size="sm" variant="muted">
          No matching skills.
        </Text>
      )}
      <Text size="xs" variant="muted">
        Pinned summaries on this page: ~{visiblePinnedTokens} tokens. Total budget:{' '}
        {SKILL_AWARENESS_TOKEN_BUDGET}; the server checks all pinned skills when saving.
      </Text>
      <Row gap="2">
        {cursor && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setCursor(undefined);
            }}
          >
            First page
          </Button>
        )}
        {nextCursor && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setCursor(nextCursor);
            }}
          >
            Next page
          </Button>
        )}
      </Row>
    </Column>
  );
}
