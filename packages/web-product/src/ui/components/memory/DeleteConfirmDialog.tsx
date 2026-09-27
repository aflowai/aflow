'use client';

import { useState } from 'react';
import { Button, Checkbox, Column, Dialog, Row, Text } from '@aflow/design-system';
import type { MemoryQueryItem, MemoryDeleteOutput } from '../../hooks/use-memory-ops.js';

export interface DeleteConfirmDialogProps {
  open: boolean;
  entry: MemoryQueryItem | null;
  onDelete: (config: Record<string, unknown>) => Promise<MemoryDeleteOutput | null>;
  onClose: () => void;
  onSuccess: () => void;
}

export function DeleteConfirmDialog({
  open,
  entry,
  onDelete,
  onClose,
  onSuccess,
}: DeleteConfirmDialogProps) {
  const [recursive, setRecursive] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  if (!entry) return null;

  const isDir = entry.entryType === 'directory' || entry.docType === 'directory';

  const handleDelete = async () => {
    setIsDeleting(true);
    const result = await onDelete({
      target: { id: entry.id, path: entry.path },
      recursive,
    });
    setIsDeleting(false);
    if (result) {
      setRecursive(false);
      onSuccess();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Delete ${isDir ? 'directory' : 'file'}?`}
      width="sm"
      footer={
        <Row gap="2" justify="end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={isDeleting}
            onClick={() => void handleDelete()}
          >
            Delete
          </Button>
        </Row>
      }
    >
      <Column gap="3">
        <Text size="sm">
          Are you sure you want to delete{' '}
          <Text as="span" variant="mono" style={{ fontWeight: 500 }}>
            {entry.path}
          </Text>
          ? This is a soft-delete and can potentially be recovered.
        </Text>
        {isDir && (
          <Checkbox
            checked={recursive}
            onChange={(e) => {
              setRecursive(e.target.checked);
            }}
          >
            Delete all contents recursively
          </Checkbox>
        )}
      </Column>
    </Dialog>
  );
}
