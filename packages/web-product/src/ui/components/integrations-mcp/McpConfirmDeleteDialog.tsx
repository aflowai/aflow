'use client';

import { useState, type ReactNode } from 'react';
import { Button, Column, Dialog, Row } from '@aflow/design-system';

/**
 * Confirmation dialog for destructive MCP actions (delete server, delete
 * connection). Mirrors `memory/_components/DeleteConfirmDialog` — same
 * shape, same `variant="danger"` action, same `loading` button state. The
 * caller passes the contextual `body` because the consequences differ:
 *
 *   - Deleting a server doesn't cascade to its connections (per the
 *     server route's design — orphan bindings stop working until a new
 *     server with the same ID is registered).
 *   - Deleting a connection removes cached tools + pinned origin; the
 *     stored credential row is untouched (operators may want to reuse it
 *     for a new connection).
 *
 * Generic enough to grow to other MCP delete sites without splitting into
 * per-target dialog components.
 */
export function McpConfirmDeleteDialog({
  open,
  title,
  body,
  confirmLabel,
  isDeleting,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  isDeleting: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!isDeleting) onClose();
      }}
      title={title}
      width="sm"
      footer={
        <Row gap="2" justify="end">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" loading={isDeleting} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </Row>
      }
    >
      <Column gap="3">{body}</Column>
    </Dialog>
  );
}

/**
 * Small convenience hook for managing delete-target state when a card or
 * tab needs to handle multiple delete kinds without each one tracking its
 * own `isDeleting` flag. Returns a `run` helper that flips the flag while
 * the supplied async work completes.
 */
export function useDeleteAction(onClose: () => void) {
  const [isDeleting, setIsDeleting] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setIsDeleting(true);
    try {
      await work();
      onClose();
    } finally {
      setIsDeleting(false);
    }
  };
  return { isDeleting, run };
}
