'use client';

import { useEffect, useRef } from 'react';
import { Button, Icon, Row, Text } from '@aflow/design-system';
import { useSpaceLlmReadiness } from '../../hooks/useSpaceLlmReadiness.js';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  fireworks: 'Fireworks AI',
  openrouter: 'OpenRouter',
};

function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

function joinProviderNames(providerIds: string[]): string {
  const names = providerIds.map(providerLabel);
  if (names.length < 2) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

/**
 * Standing guidance above the composer: missing or rejected provider keys
 * render as a one-click fix, recomputed from live readiness — never a
 * persisted flag.
 */
export function LlmReadinessBanner({
  spaceId,
  onReviewModels,
}: {
  spaceId: string;
  onReviewModels: () => void;
}) {
  const { readiness } = useSpaceLlmReadiness(spaceId);
  const autoOpenedSpace = useRef<string | null>(null);

  useEffect(() => {
    if (!readiness || readiness.ready || autoOpenedSpace.current === spaceId) return;
    autoOpenedSpace.current = spaceId;
    onReviewModels();
  }, [onReviewModels, readiness, spaceId]);

  if (!readiness || readiness.ready) return null;

  const missing = readiness.missingProviders;
  const errored = readiness.erroredProviders;
  const unknownModels = readiness.unknownModelRoles;
  if (missing.length === 0 && errored.length === 0 && unknownModels.length === 0) return null;

  // Stated first: a model the catalog no longer carries cannot be fixed by any
  // key, so naming a credential alongside it would offer a remedy that does
  // nothing. The banner says what changed and points at the model picker.
  const retiredNames = [...new Set(unknownModels.map((entry) => entry.model))];
  const unknownMessage =
    unknownModels.length > 0
      ? `${retiredNames.length === 1 ? `The model ${retiredNames[0]} is` : `The models ${retiredNames.join(', ')} are`} no longer available. Choose ${unknownModels.length === 1 ? 'another model' : 'other models'} for ${unknownModels.map((entry) => entry.role).join(', ')}.`
      : null;

  const isMissing = missing.length > 0;
  const providers = isMissing ? missing : errored;
  const names = joinProviderNames(providers.map((provider) => provider.providerId));
  const oneProvider = providers.length === 1;
  const oneModel = new Set(providers.flatMap((provider) => provider.roles)).size === 1;
  const subject = oneModel ? 'the selected model' : 'selected models';
  const providerKey = oneProvider ? `a ${names} key` : `keys for ${names}`;
  const modelAlternative = oneModel ? 'a model' : 'models';
  const providerAlternative = oneProvider ? 'another provider' : 'other providers';

  return (
    <Row
      gap="sm"
      style={{
        alignItems: 'center',
        padding: 'var(--space-2) var(--space-3)',
        margin: '0 0 var(--space-2)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-1)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      <Icon
        name="warning-circle"
        size="sm"
        style={{ color: 'var(--color-status-attention, var(--color-text-muted))', flexShrink: 0 }}
      />
      <Text size="sm" style={{ flex: 1 }}>
        {unknownMessage ??
          (isMissing
            ? `To run agents, ${subject} requires ${providerKey}. Add ${oneProvider ? 'the key' : 'them'}, or choose ${modelAlternative} from ${providerAlternative}.`
            : `${oneProvider ? `The ${names} key used by ${subject} was rejected` : `The keys for ${names} used by ${subject} were rejected`}. Update ${oneProvider ? 'the key' : 'them'}, or choose ${modelAlternative} from ${providerAlternative}.`)}
      </Text>
      <Button variant="secondary" size="sm" onClick={onReviewModels}>
        Review models
      </Button>
    </Row>
  );
}
