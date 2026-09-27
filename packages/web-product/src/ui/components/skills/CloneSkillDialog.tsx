'use client';

import { useEffect, useState } from 'react';
import { Button, Column, Dialog, Field, Input, Text } from '@aflow/design-system';
import { slugify } from '@aflow/schemas';

import { useApiMutation } from '../../hooks/useApiQuery.js';

/**
 * Clone the selected skill under a new name. The server copies the definition
 * (workflow, campaign contract, activation) through the same authority as
 * create; runs, learnings, campaigns and evals stay with the original. On
 * success we navigate the operator into the designer on the new slug.
 */
export function CloneSkillDialog({
  open,
  onClose,
  spaceId,
  sourceSlug,
  sourceName,
  onCloned,
}: {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  sourceSlug: string;
  sourceName: string;
  onCloned: (slug: string) => void;
}) {
  const [name, setName] = useState('');

  // The dialog stays mounted across open/close; seed the default name per
  // source each time it opens.
  useEffect(() => {
    if (open) setName(`${sourceName} copy`);
  }, [open, sourceName]);

  const mutation = useApiMutation<{ name: string }, { slug: string }>({
    path: `/spaces/${spaceId}/skills/${sourceSlug}/clone`,
    method: 'POST',
    spaceId,
    invalidate: [['space', spaceId, 'workflows', 'all']],
    onSuccess: (out) => {
      onCloned(out.slug);
    },
  });

  const close = () => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };

  const slug = slugify(name);
  const slugValid = slug.length >= 3 && slug.length <= 64;
  const canSubmit = slugValid && !mutation.isPending;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Clone “${sourceName}”`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate({ name: name.trim() });
            }}
          >
            {mutation.isPending ? 'Cloning…' : 'Clone skill'}
          </Button>
        </>
      }
    >
      <Column gap="md">
        <Field
          label="Name"
          required
          {...(name
            ? {
                helperText: slugValid ? `Slug: ${slug}` : 'Use at least 3 alphanumeric characters.',
              }
            : {})}
        >
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            autoFocus
            maxLength={120}
          />
        </Field>
        <Text size="sm" color="muted">
          Copies the workflow, campaign contract, and activation into an independent skill you can
          edit freely. Runs, learnings, campaigns, and evals stay with the original.
        </Text>
        {mutation.error && (
          <Text size="sm" tone="danger">
            {mutation.error.message}
          </Text>
        )}
      </Column>
    </Dialog>
  );
}
