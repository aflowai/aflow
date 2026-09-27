'use client';

import { useState } from 'react';
import { Button, Column, Dialog, Field, Input, Row, Select, Text } from '@aflow/design-system';
import type { MemoryPutOutput, MemoryMkdirOutput } from '../../hooks/use-memory-ops.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DOC_TYPES = [
  'markdown',
  'text',
  'json',
  'code',
  'prompt',
  'report',
  'dataset',
  'artifact',
  'schema',
  'ndjson',
] as const;

export interface CreateEntryDialogProps {
  open: boolean;
  mode: 'file' | 'dir';
  currentPath: string;
  onPut: (config: Record<string, unknown>) => Promise<MemoryPutOutput | null>;
  onMkdir: (config: Record<string, unknown>) => Promise<MemoryMkdirOutput | null>;
  onClose: () => void;
  onSuccess: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateEntryDialog({
  open,
  mode,
  currentPath,
  onPut,
  onMkdir,
  onClose,
  onSuccess,
}: CreateEntryDialogProps) {
  const [name, setName] = useState('');
  const [docType, setDocType] = useState('markdown');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const basePath = currentPath.endsWith('/') ? currentPath : currentPath + '/';
  const fullPath = basePath + name;

  const reset = () => {
    setName('');
    setDocType('markdown');
    setContent('');
    setDescription('');
    setTags('');
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setIsSubmitting(true);
    setError(null);

    const parsedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    let result: MemoryPutOutput | MemoryMkdirOutput | null;

    if (mode === 'dir') {
      const config: Record<string, unknown> = {
        path: fullPath,
        parents: true,
      };
      if (description) config['description'] = description;
      if (parsedTags.length > 0) config['tags'] = parsedTags;
      result = await onMkdir(config);
    } else {
      const config: Record<string, unknown> = {
        path: fullPath,
        docType,
        writeMode: 'create',
        content,
      };
      if (parsedTags.length > 0) config['tags'] = parsedTags;
      result = await onPut(config);
    }

    setIsSubmitting(false);

    if (result) {
      reset();
      onSuccess();
    } else {
      setError('Failed to create entry');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={mode === 'file' ? 'Create File' : 'Create Directory'}
      width="md"
      footer={
        <Row gap="2" justify="end">
          <Button variant="secondary" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button size="sm" loading={isSubmitting} onClick={() => void handleSubmit()}>
            Create
          </Button>
        </Row>
      }
    >
      <Column gap="4">
        <Field label="Name" required>
          <Input
            value={name}
            placeholder={mode === 'file' ? 'e.g. notes.md' : 'e.g. documents'}
            onChange={(e) => {
              setName(e.target.value);
            }}
            autoFocus
          />
          <Text size="xs" variant="muted" style={{ marginTop: 'var(--space-1)' }}>
            Full path: {fullPath || `${basePath}...`}
          </Text>
        </Field>

        {mode === 'file' && (
          <Field label="Document Type">
            <Select
              value={docType}
              onChange={(e) => {
                setDocType(e.target.value);
              }}
            >
              {DOC_TYPES.map((dt) => (
                <option key={dt} value={dt}>
                  {dt}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {mode === 'dir' && (
          <Field label="Description">
            <Input
              value={description}
              placeholder="Optional description for this directory"
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </Field>
        )}

        {mode === 'file' && (
          <Field label="Content">
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
              }}
              rows={10}
              placeholder="File content (can be empty)"
              style={{
                width: '100%',
                resize: 'vertical',
                fontFamily: 'var(--font-family-mono)',
                fontSize: 'var(--font-size-sm)',
                padding: 'var(--space-2)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--color-surface-0)',
                color: 'var(--color-text-primary)',
              }}
            />
          </Field>
        )}

        <Field label="Tags" helperText="Comma-separated">
          <Input
            value={tags}
            placeholder="e.g. notes, important"
            onChange={(e) => {
              setTags(e.target.value);
            }}
          />
        </Field>

        {error && (
          <Text size="sm" tone="danger">
            {error}
          </Text>
        )}
      </Column>
    </Dialog>
  );
}
