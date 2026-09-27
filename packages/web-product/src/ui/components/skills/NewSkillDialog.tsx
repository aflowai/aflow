'use client';

import { useState } from 'react';
import { Button, Column, Dialog, Field, Input, Select, Text, Textarea } from '@aflow/design-system';
import { slugify } from '@aflow/schemas';

import { useApiMutation } from '../../hooks/useApiQuery.js';

/**
 * Create a new skill from a starter template. The server builds a minimal valid
 * skill and applies it through the same authority the agent uses; on success we
 * navigate the operator into the designer on the new slug to flesh it out.
 */
export function NewSkillDialog({
  open,
  onClose,
  spaceId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [archetype, setArchetype] = useState<'process' | 'project'>('process');

  const reset = () => {
    setName('');
    setGoal('');
    setArchetype('process');
  };

  const mutation = useApiMutation<
    { name: string; goal: string; archetype: string },
    { slug: string }
  >({
    path: `/spaces/${spaceId}/skills`,
    method: 'POST',
    spaceId,
    invalidate: [['space', spaceId, 'workflows', 'all']],
    onSuccess: (out) => {
      reset();
      onCreated(out.slug);
    },
  });

  const close = () => {
    if (mutation.isPending) return;
    // The dialog stays mounted across open/close, so clear the mutation cache
    // (a prior error) along with the form — otherwise a stale error shows on
    // reopen.
    mutation.reset();
    reset();
    onClose();
  };

  const slug = slugify(name);
  const slugValid = slug.length >= 3 && slug.length <= 64;
  const canSubmit = slugValid && goal.trim().length > 0 && !mutation.isPending;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New skill"
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
              mutation.mutate({ name: name.trim(), goal: goal.trim(), archetype });
            }}
          >
            {mutation.isPending ? 'Creating…' : 'Create skill'}
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
            placeholder="e.g. Weekly market briefing"
            autoFocus
            maxLength={120}
          />
        </Field>
        <Field
          label="Goal"
          required
          helperText="What should a successful run achieve? Refine it in the designer."
        >
          <Textarea
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
            }}
            rows={3}
            maxLength={2000}
            placeholder="Describe the outcome this skill is for."
          />
        </Field>
        <Field
          label="Template"
          helperText="Optimization skills are authored with their metric + campaign contract — describe one to the agent, or use the contract editor."
        >
          <Select
            value={archetype}
            onChange={(e) => {
              setArchetype(e.target.value as 'process' | 'project');
            }}
          >
            <option value="process">Process — a repeatable multi-step procedure</option>
            <option value="project">Project — a one-off goal with milestones</option>
            <option value="optimization" disabled>
              Optimization — needs a metric + contract (not available here yet)
            </option>
          </Select>
        </Field>
        {mutation.error && (
          <Text size="sm" tone="danger">
            {mutation.error.message}
          </Text>
        )}
      </Column>
    </Dialog>
  );
}
