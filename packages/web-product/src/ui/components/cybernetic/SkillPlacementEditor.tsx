'use client';
import { useState } from 'react';
import { Button, Column, Input, Row, Text } from '@aflow/design-system';
import type { CapabilityPlacement, SkillDiscoveryEntry } from '@aflow/schemas';
import { skillPlacement, skillAwarenessTokens, SKILL_AWARENESS_TOKEN_BUDGET } from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { PlacementSelect } from './surfaceRow.js';

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
    <Column gap="sm" style={{ marginTop: 'var(--space-3)' }}>
      <Text size="sm" weight="semibold">
        Skills · {result.data?.total ?? '…'} installed
      </Text>
      <Text size="xs" variant="muted">
        New skills are on demand. Always on pins a compact activation summary. Off allows direct
        operator invocation, schedules and declared dependencies, while excluding autonomous
        Helmsman selection.
      </Text>
      <Input
        type="search"
        placeholder="Search installed skills…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(undefined);
        }}
      />
      {result.isError && <Text size="xs">Couldn’t load skills: {result.error.message}</Text>}
      {result.isLoading && <Text size="xs">Loading skills…</Text>}
      {entries.map((entry) => (
        <div key={entry.slug}>
          <Row align="center" gap="2">
            <Text size="sm" style={{ flex: 1 }}>
              {entry.name}
            </Text>
            <PlacementSelect
              ariaLabel={`${entry.name} skill placement`}
              value={placements[entry.slug] ?? 'default'}
              options={[
                { value: 'default', label: 'Default · on demand' },
                { value: 'always_on', label: 'Always on' },
                { value: 'on_demand', label: 'On demand' },
                { value: 'off', label: 'Off' },
              ]}
              onChange={(value) => {
                onPlace(entry.slug, value === 'default' ? undefined : value);
              }}
            />
          </Row>
          <Text size="xs" variant="muted">
            {entry.status} · ~{skillAwarenessTokens([entry])} summary tokens
          </Text>
          <details>
            <summary>
              <Text size="xs" variant="muted">
                When to use
              </Text>
            </summary>
            <Text size="xs" variant="muted">
              {entry.description}
            </Text>
          </details>
        </div>
      ))}
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
