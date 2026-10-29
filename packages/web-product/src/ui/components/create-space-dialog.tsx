'use client';

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Dialog, Button, Text, Column, Row, Spinner, Icon } from '@aflow/design-system';
import { CreateSpaceForm, type CreateSpaceResult } from './create-space-form.js';
import { QuickStartPicker } from './quick-start-picker.js';
import { useQuickStartOffer } from '../hooks/use-quick-starts.js';
import { useSpaceLlmReadiness } from '../hooks/useSpaceLlmReadiness.js';
import { spaceRoute } from '../lib/space-routes.js';

export interface CreateSpaceDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (space: CreateSpaceResult) => void;
}

/**
 * The one way to make a space: a choice between a blank workspace and each
 * quick start on the shelf (Plan 334 D2). With no template on the shelf the
 * choice is skipped and the blank form opens directly.
 */
export function CreateSpaceDialog({ open, onClose, onCreated }: CreateSpaceDialogProps) {
  const [created, setCreated] = useState<CreateSpaceResult | null>(null);
  const [blankChosen, setBlankChosen] = useState(false);
  const offer = useQuickStartOffer();

  if (!open) return null;

  const close = () => {
    setCreated(null);
    setBlankChosen(false);
    onClose();
  };
  const hasTemplates = (offer.data?.templates.length ?? 0) > 0;

  let body: ReactNode;
  if (created) {
    body = (
      <ReadinessGate
        space={created}
        onContinue={() => {
          const space = created;
          setCreated(null);
          setBlankChosen(false);
          onCreated(space);
        }}
        onDismiss={close}
      />
    );
  } else if (offer.isLoading) {
    body = (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner label="Loading…" />
      </Row>
    );
  } else if (!hasTemplates) {
    body = <CreateSpaceForm onCreated={setCreated} autoFocus />;
  } else if (blankChosen) {
    body = (
      <Column gap="sm">
        <BackLink
          onClick={() => {
            setBlankChosen(false);
          }}
        />
        <CreateSpaceForm onCreated={setCreated} autoFocus />
      </Column>
    );
  } else {
    body = (
      <Column gap="md">
        <Text variant="muted">
          Start blank, or from a quick start that comes with the skills and directives for one kind
          of work.
        </Text>
        <QuickStartPicker
          leadingCard={{
            title: 'Blank workspace',
            description: 'Name it and set it up yourself.',
            icon: 'plus',
            onChoose: () => {
              setBlankChosen(true);
            },
          }}
          onCreated={close}
        />
      </Column>
    );
  }

  return createPortal(
    <div style={{ position: 'relative', zIndex: 10001 }}>
      <Dialog
        open={open}
        onClose={close}
        title={created ? 'Workspace ready' : 'Create new workspace'}
        width="md"
      >
        {body}
      </Dialog>
    </div>,
    document.body,
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 'var(--space-1)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        fontSize: 'var(--font-size-sm)',
        color: 'var(--color-text-muted)',
      }}
    >
      <Icon name="arrow-left" size="sm" />
      Back
    </button>
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
