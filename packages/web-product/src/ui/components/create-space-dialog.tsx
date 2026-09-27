'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Dialog, Button, Text, Column, Row, Spinner, Icon } from '@aflow/design-system';
import { CreateSpaceForm, type CreateSpaceResult } from './create-space-form.js';
import { useSpaceLlmReadiness } from '../hooks/useSpaceLlmReadiness.js';
import { spaceRoute } from '../lib/space-routes.js';

export interface CreateSpaceDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (space: CreateSpaceResult) => void;
}

export function CreateSpaceDialog({ open, onClose, onCreated }: CreateSpaceDialogProps) {
  const [created, setCreated] = useState<CreateSpaceResult | null>(null);

  if (!open) return null;

  return createPortal(
    <div style={{ position: 'relative', zIndex: 10001 }}>
      <Dialog
        open={open}
        onClose={() => {
          setCreated(null);
          onClose();
        }}
        title={created ? 'Workspace ready' : 'Create new workspace'}
        width="md"
      >
        {created ? (
          <ReadinessGate
            space={created}
            onContinue={() => {
              const space = created;
              setCreated(null);
              onCreated(space);
            }}
            onDismiss={() => {
              setCreated(null);
              onClose();
            }}
          />
        ) : (
          <CreateSpaceForm onCreated={setCreated} autoFocus />
        )}
      </Dialog>
    </div>,
    document.body,
  );
}

/**
 * After creation, confirm the space can actually run agents. If a provider
 * key resolves for every role we route straight to chat; otherwise the gap
 * is shown here (at creation) with a path to fix it — the chat readiness
 * banner is the standing surface thereafter.
 */
function ReadinessGate({
  space,
  onContinue,
  onDismiss,
}: {
  space: CreateSpaceResult;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  const router = useRouter();
  const { readiness, isLoading } = useSpaceLlmReadiness(space.id);

  if (isLoading || !readiness) {
    return (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner label="Checking models…" />
      </Row>
    );
  }

  if (readiness.ready) {
    return (
      <Column gap="md">
        <Row gap="sm" align="center">
          <Icon name="check-circle" size="md" style={{ color: 'var(--color-status-success-fg)' }} />
          <Text>Your workspace is ready to run agents.</Text>
        </Row>
        <Row justify="end">
          <Button variant="primary" onClick={onContinue}>
            Open chat
          </Button>
        </Row>
      </Column>
    );
  }

  return (
    <Column gap="md">
      <Text>
        This workspace needs an AI provider key before its agents can run. You can add one now, or
        continue to chat — the readiness banner will remind you there.
      </Text>
      <Row gap="sm" justify="end">
        <Button variant="secondary" onClick={onContinue}>
          Continue to chat
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            onDismiss();
            router.push(spaceRoute(space.slug, '/settings/credentials'));
          }}
        >
          Add a provider key
        </Button>
      </Row>
    </Column>
  );
}
