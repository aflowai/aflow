'use client';

import { useCallback, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  Column,
  Dialog,
  Divider,
  Field,
  Icon,
  Input,
  Label,
  Row,
  Text,
} from '@aflow/design-system';

export function ApiCredentialDialog({
  credentialKey,
  defaultLabel,
  existing,
  onSave,
  onDelete,
  onClose,
}: {
  credentialKey: string;
  defaultLabel: string;
  existing: boolean;
  onSave: (value: string, label: string, description?: string) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [label, setLabel] = useState(defaultLabel);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!value.trim() || !label.trim()) return;
    setSaving(true);
    try {
      await onSave(value.trim(), label.trim(), description.trim() || undefined);
    } finally {
      setSaving(false);
    }
  }, [value, label, description, onSave]);

  return (
    <Dialog open onClose={onClose} title={existing ? 'Update Secret' : 'Add Secret'}>
      <Column gap="3" style={{ padding: 'var(--space-4)', maxWidth: 500, width: '100%' }}>
        <Card
          style={{
            background: 'var(--color-success-bg)',
            borderColor: 'var(--color-success-default)',
          }}
        >
          <CardBody style={{ padding: 'var(--space-2) var(--space-3)' }}>
            <Row gap="2" align="center">
              <Icon
                name="lock-key"
                size="sm"
                style={{ color: 'var(--color-success-fg)', flexShrink: 0 }}
              />
              <Text size="sm" tone="success">
                This value is encrypted at rest and <strong>never shown again</strong> after saving.
              </Text>
            </Row>
          </CardBody>
        </Card>

        <Field>
          <Label>Credential Key</Label>
          <Input value={credentialKey} readOnly />
        </Field>

        <Field>
          <Label>Label</Label>
          <Input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
            placeholder="e.g. My GitHub Token"
          />
        </Field>

        <div className="ds-secret-field-group">
          <Field>
            <Label>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Icon name="lock-key" size="sm" style={{ color: 'var(--color-success-fg)' }} />
                Secret value
              </span>
            </Label>
            <Input
              className="ds-input--secret"
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
              }}
              placeholder={
                existing ? '(enter new value to replace)' : 'Paste your API key or token'
              }
              autoFocus
            />
            <Text size="xs" tone="success" style={{ marginTop: 'var(--space-1)' }}>
              Encrypted at rest. Never shown again after you save.
            </Text>
          </Field>
        </div>

        <Field>
          <Label>Description (optional)</Label>
          <Input
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            placeholder="e.g. Production key from dashboard"
          />
        </Field>

        <Divider />

        <Row justify="between">
          {onDelete ? (
            <Button variant="danger" onClick={() => void onDelete()}>
              <Icon name="trash" size="sm" /> Remove
            </Button>
          ) : (
            <div />
          )}
          <Row gap="2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={!value.trim() || !label.trim() || saving}
            >
              {saving ? 'Saving...' : existing ? 'Update' : 'Save'}
            </Button>
          </Row>
        </Row>
      </Column>
    </Dialog>
  );
}
