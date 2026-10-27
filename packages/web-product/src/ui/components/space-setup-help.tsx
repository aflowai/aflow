'use client';

import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Column, Row, Text } from '@aflow/design-system';
import { useEdition } from '../hooks/useEdition.js';
import { useSpaceReadiness } from '../hooks/use-store.js';
import { useSpace } from './providers.js';
import { SetupChecklist } from './setup-checklist.js';

const STATUS_BADGE = {
  ready: { label: 'Ready', variant: 'success' },
  needs_setup: { label: 'Needs setup', variant: 'warning' },
  broken: { label: 'Broken', variant: 'danger' },
} as const;

/**
 * The space's help surface for its setup (Plan 330 D4): the readiness of each
 * quick start the space was made from, read by the same function and rendered
 * by the same checklist as the bundle install and the Store page. Local only:
 * the quick starts it reads need a paired machine, which only Aflow Local has.
 */
export function SpaceSetupHelp(): ReactElement | null {
  const router = useRouter();
  const edition = useEdition();
  const { activeSpace } = useSpace();
  const local = edition.id === 'community-local';
  const readiness = useSpaceReadiness(local ? (activeSpace?.id ?? '') : '');
  const templates = readiness.data?.templates ?? [];
  if (!local || activeSpace === null || templates.length === 0) return null;
  return (
    <Column gap="lg" style={{ padding: 'var(--space-5) var(--space-5) 0', maxWidth: 880 }}>
      {templates.map((template) => {
        const badge = STATUS_BADGE[template.status];
        return (
          <Column key={template.catalogId} gap="sm">
            <Row gap="sm" align="center" wrap>
              <Text size="xl" weight="semibold">
                Setting up {activeSpace.name}
              </Text>
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </Row>
            <Text size="sm" variant="muted">
              This space was made from {template.name}. Each item reads where it stands now, and the
              space is ready once every required item is done.
            </Text>
            <SetupChecklist
              tasks={template.tasks}
              spaceSlug={activeSpace.slug}
              spaceId={activeSpace.id}
              onNavigate={(path) => {
                router.push(path);
              }}
            />
          </Column>
        );
      })}
    </Column>
  );
}
