'use client';

import Link from 'next/link';
import { Row, Text, Button, IconButton, Icon, Tooltip, useBreakpoint } from '@aflow/design-system';
import type { ValidationResult } from '../../lib/flow-validation.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EditorToolbarProps {
  flowName: string;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  validation: ValidationResult;
  isPublishing: boolean;
  showJsonView: boolean;
  backToChatHref?: string | undefined;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onPublish: () => void;
  onAddStep: () => void;
  onToggleJsonView: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EditorToolbar({
  flowName,
  isDirty,
  canUndo,
  canRedo,
  validation,
  isPublishing,
  showJsonView,
  backToChatHref,
  onUndo,
  onRedo,
  onAutoLayout,
  onPublish,
  onAddStep,
  onToggleJsonView,
}: EditorToolbarProps) {
  const { isMobile } = useBreakpoint();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: isMobile ? 'var(--space-1) var(--space-2)' : 'var(--space-2) var(--space-3)',
        borderBottom: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-canvas)',
        minHeight: 44,
        gap: isMobile ? 'var(--space-1)' : 'var(--space-3)',
        flexWrap: isMobile ? 'wrap' : 'nowrap',
      }}
    >
      {/* Left: Back to chat (when from chat) + Flow name + dirty indicator */}
      <Row gap="2" align="center" style={{ flex: 1, minWidth: 0 }}>
        {backToChatHref && (
          <Tooltip content="Back to chat" side="bottom">
            <Link
              href={backToChatHref}
              className="ds-button ds-button--ghost ds-button--sm"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                textDecoration: 'none',
                color: 'inherit',
                flexShrink: 0,
              }}
            >
              <Icon name="chat" size="sm" />
              {!isMobile && <span>Chat</span>}
            </Link>
          </Tooltip>
        )}
        {backToChatHref && !isMobile && (
          <div style={{ width: 1, height: 16, background: 'var(--color-border-subtle)' }} />
        )}
        <Text
          size="sm"
          style={{
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: isMobile ? 100 : undefined,
          }}
        >
          {flowName}
        </Text>
        {isDirty && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--color-warning-default)',
              flexShrink: 0,
            }}
          />
        )}
      </Row>

      {/* Center: Actions */}
      <Row gap="1" align="center">
        <Tooltip content="Undo (Ctrl+Z)">
          <IconButton
            icon={<Icon name="undo" size="sm" />}
            size="sm"
            variant="ghost"
            aria-label="Undo"
            onClick={onUndo}
            disabled={!canUndo}
          />
        </Tooltip>
        <Tooltip content="Redo (Ctrl+Shift+Z)">
          <IconButton
            icon={<Icon name="refresh" size="sm" />}
            size="sm"
            variant="ghost"
            aria-label="Redo"
            onClick={onRedo}
            disabled={!canRedo}
          />
        </Tooltip>

        {!isMobile && (
          <div
            style={{
              width: 1,
              height: 20,
              background: 'var(--color-border-subtle)',
              margin: '0 var(--space-1)',
            }}
          />
        )}

        <Tooltip content="Add step">
          <IconButton
            icon={<Icon name="plus" size="sm" />}
            size="sm"
            variant="ghost"
            aria-label="Add step"
            onClick={onAddStep}
          />
        </Tooltip>
        {!isMobile && (
          <Tooltip content="Auto-layout">
            <IconButton
              icon={<Icon name="flow" size="sm" />}
              size="sm"
              variant="ghost"
              aria-label="Auto-layout"
              onClick={onAutoLayout}
            />
          </Tooltip>
        )}
        <Tooltip content={showJsonView ? 'Visual editor' : 'View JSON'}>
          <IconButton
            icon={<Icon name="code" size="sm" />}
            size="sm"
            variant={showJsonView ? 'secondary' : 'ghost'}
            aria-label={showJsonView ? 'Visual editor' : 'View JSON'}
            onClick={onToggleJsonView}
          />
        </Tooltip>
      </Row>

      {/* Right: Validation + Publish */}
      <Row gap="2" align="center" justify="end" style={{ flex: isMobile ? undefined : 1 }}>
        {!isMobile && <ValidationSummary validation={validation} />}
        {isMobile ? (
          <IconButton
            icon={<Icon name="sync" size="sm" />}
            size="sm"
            variant="primary"
            aria-label={isPublishing ? 'Publishing...' : 'Publish'}
            onClick={onPublish}
            disabled={!validation.valid || isPublishing}
          />
        ) : (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="sync" size="sm" />}
            onClick={onPublish}
            disabled={!validation.valid || isPublishing}
          >
            {isPublishing ? 'Publishing...' : 'Publish'}
          </Button>
        )}
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation summary
// ---------------------------------------------------------------------------

function ValidationSummary({ validation }: { validation: ValidationResult }) {
  if (validation.errorCount === 0 && validation.warningCount === 0) {
    return (
      <Row gap="1" align="center">
        <Icon
          name="check-circle"
          size="sm"
          weight="fill"
          style={{ color: 'var(--color-success-default)' }}
        />
        <Text variant="muted" size="xs">
          Valid
        </Text>
      </Row>
    );
  }

  return (
    <Row gap="2" align="center">
      {validation.errorCount > 0 && (
        <Row gap="1" align="center">
          <Icon name="x" size="sm" weight="fill" style={{ color: 'var(--color-danger-default)' }} />
          <Text size="xs" style={{ color: 'var(--color-danger-default)' }}>
            {validation.errorCount} {validation.errorCount === 1 ? 'error' : 'errors'}
          </Text>
        </Row>
      )}
      {validation.warningCount > 0 && (
        <Row gap="1" align="center">
          <Icon
            name="warning-circle"
            size="sm"
            weight="fill"
            style={{ color: 'var(--color-warning-default)' }}
          />
          <Text size="xs" style={{ color: 'var(--color-warning-default)' }}>
            {validation.warningCount} {validation.warningCount === 1 ? 'warning' : 'warnings'}
          </Text>
        </Row>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Validation bar (bottom, expandable)
// ---------------------------------------------------------------------------

export function ValidationBar({ validation }: { validation: ValidationResult }) {
  if (validation.issues.length === 0) return null;

  return (
    <div
      style={{
        borderTop: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-canvas)',
        maxHeight: 200,
        overflow: 'auto',
        padding: 'var(--space-2) var(--space-3)',
      }}
    >
      {validation.issues.map((issue, i) => (
        <Row
          key={i}
          gap="2"
          align="start"
          style={{
            padding: 'var(--space-1) 0',
            borderBottom:
              i < validation.issues.length - 1 ? '1px solid var(--color-border-subtle)' : undefined,
          }}
        >
          <Icon
            name={issue.level === 'error' ? 'x' : 'warning-circle'}
            size="xs"
            weight="fill"
            style={{
              color:
                issue.level === 'error'
                  ? 'var(--color-danger-default)'
                  : 'var(--color-warning-default)',
              flexShrink: 0,
            }}
          />
          <Text
            as="span"
            size="xs"
            style={{
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-content-muted)',
              lineHeight: 1.25,
            }}
          >
            {issue.path}
          </Text>
          <Text as="span" size="xs" style={{ lineHeight: 1.25 }}>
            {issue.message}
          </Text>
        </Row>
      ))}
    </div>
  );
}
