'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardBody,
  Column,
  Dialog,
  Icon,
  Input,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';
import type { QuickStartOffer } from '@aflow/schemas';
import { useQuickStartOffer, useStartQuickStart } from '../hooks/use-quick-starts.js';
import { ApiError } from '../lib/query-client.js';
import { spaceRoute } from '../lib/space-routes.js';
import { toSlug } from './create-space-form.js';
import { useSpace } from './providers.js';

type QuickStartTemplate = QuickStartOffer['templates'][number];

/** Numbered handles before a random one, when the name's own handle is taken. */
const SLUG_ATTEMPTS = 5;

function slugCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base;
  const suffix =
    attempt < SLUG_ATTEMPTS ? String(attempt + 1) : Math.random().toString(36).slice(2, 7);
  return `${base.slice(0, 64 - suffix.length - 1).replace(/-+$/, '')}-${suffix}`;
}

function isSlugTaken(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const code = (error.body as { error?: unknown } | null)?.error;
  return code === 'Conflict' || code === 'SLUG_RETIRED';
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown; error?: unknown } | null;
    if (typeof body?.message === 'string') return body.message;
    if (typeof body?.error === 'string') return body.error;
    return error.message;
  }
  return 'The space could not be created. Try again.';
}

export interface QuickStartPickerProps {
  /** Preselects a template, as the Store page does for the listing it shows. */
  initialCatalogId?: string;
  /**
   * The first-run offer shows the empty space beside the templates; choosing
   * it keeps that space and makes nothing.
   */
  emptySpace?: QuickStartOffer['emptySpace'];
  onKeepEmptySpace?: () => void;
  onCreated?: () => void;
}

/**
 * Choose a quick start, name the space it makes, and make it. The new space is
 * created by the Store install of the template, and nothing in any other space
 * changes (Plan 330 D1).
 */
export function QuickStartPicker({
  initialCatalogId,
  emptySpace,
  onKeepEmptySpace,
  onCreated,
}: QuickStartPickerProps) {
  const router = useRouter();
  const { refresh } = useSpace();
  const offer = useQuickStartOffer();
  const start = useStartQuickStart();
  const [selectedId, setSelectedId] = useState<string | undefined>(initialCatalogId);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (offer.isLoading) {
    return (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner label="Loading quick starts…" />
      </Row>
    );
  }
  const templates = offer.data?.templates ?? [];
  const selected = templates.find((template) => template.catalogId === selectedId);
  const spaceName = name.trim() || selected?.spaceName || '';

  const create = async (template: QuickStartTemplate) => {
    setError(null);
    const base = toSlug(spaceName) || toSlug(template.spaceName);
    for (let attempt = 0; attempt <= SLUG_ATTEMPTS; attempt += 1) {
      try {
        const response = await start.mutateAsync({
          catalogId: template.catalogId,
          expectedVersion: template.version,
          idempotencyKey: crypto.randomUUID(),
          name: spaceName,
          slug: slugCandidate(base, attempt),
        });
        if (response.result.kind !== 'space') return;
        refresh();
        onCreated?.();
        router.push(spaceRoute(response.result.spaceSlug, '/chat'));
        return;
      } catch (err) {
        if (isSlugTaken(err) && attempt < SLUG_ATTEMPTS) continue;
        setError(errorText(err));
        return;
      }
    }
  };

  if (templates.length === 0) {
    return <Text variant="muted">No quick starts are available here.</Text>;
  }

  return (
    <Column gap="md">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 'var(--space-3)',
        }}
      >
        {emptySpace && (
          <Card
            interactive
            onClick={onKeepEmptySpace}
            role="button"
            aria-label={`Keep ${emptySpace.name}`}
          >
            <CardBody>
              <Column gap="xs">
                <Row gap="sm" align="center">
                  <Icon name="buildings" size="md" />
                  <Text size="sm" weight="semibold">
                    {emptySpace.name}
                  </Text>
                </Row>
                <Text size="xs" variant="muted">
                  Keep the empty space you have and set it up yourself.
                </Text>
              </Column>
            </CardBody>
          </Card>
        )}
        {templates.map((template) => {
          const isSelected = template.catalogId === selectedId;
          return (
            <Card
              key={template.catalogId}
              interactive
              role="button"
              aria-pressed={isSelected}
              onClick={() => {
                setSelectedId(template.catalogId);
                setError(null);
              }}
              style={
                isSelected
                  ? { outline: '2px solid var(--color-accent-default)', outlineOffset: -1 }
                  : undefined
              }
            >
              <CardBody>
                <Column gap="xs">
                  <Row gap="sm" align="center">
                    <Icon name="lightning" size="md" />
                    <Text size="sm" weight="semibold">
                      {template.name}
                    </Text>
                  </Row>
                  <Text size="xs" variant="muted">
                    {template.tagline}
                  </Text>
                </Column>
              </CardBody>
            </Card>
          );
        })}
      </div>

      {selected && (
        <Column gap="sm">
          <label htmlFor="quick-start-name">
            <Text size="sm" weight="medium">
              Name the new space
            </Text>
          </label>
          <Input
            id="quick-start-name"
            value={name}
            placeholder={selected.spaceName}
            onChange={(event) => {
              setName(event.target.value);
            }}
            style={{ width: '100%' }}
          />
          {emptySpace && (
            <Text size="xs" variant="muted">
              {emptySpace.name} stays as it is.
            </Text>
          )}
          {error && (
            <Text size="sm" style={{ color: 'var(--color-status-danger-fg)' }}>
              {error}
            </Text>
          )}
          <Row justify="end">
            <Button
              variant="primary"
              loading={start.isPending}
              disabled={!spaceName}
              onClick={() => void create(selected)}
            >
              Create the space
            </Button>
          </Row>
        </Column>
      )}
    </Column>
  );
}

export interface QuickStartDialogProps {
  open: boolean;
  onClose: () => void;
  initialCatalogId?: string;
}

/** "Start from a quick start" — the space switcher's and the Store page's way in. */
export function QuickStartDialog({ open, onClose, initialCatalogId }: QuickStartDialogProps) {
  if (!open) return null;
  return createPortal(
    <div style={{ position: 'relative', zIndex: 10001 }}>
      <Dialog open={open} onClose={onClose} title="Start from a quick start" width="lg">
        <QuickStartPicker
          {...(initialCatalogId !== undefined ? { initialCatalogId } : {})}
          onCreated={onClose}
        />
      </Dialog>
    </div>,
    document.body,
  );
}
