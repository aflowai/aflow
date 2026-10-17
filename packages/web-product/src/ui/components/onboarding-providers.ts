import type { AgentModelProviderId } from '@aflow/schemas';

export function providerDisplayName(providerId: AgentModelProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'google':
      return 'Google';
    case 'openai':
      return 'OpenAI';
    case 'fireworks':
      return 'Fireworks AI';
    case 'xai':
      return 'xAI';
  }
}

export interface ProviderFieldMeta {
  displayName: string;
  placeholder: string;
  helpText: string;
  docsUrl: string | null;
}

export const PROVIDER_FALLBACK_META: Record<AgentModelProviderId, ProviderFieldMeta> = {
  anthropic: {
    displayName: 'Anthropic',
    placeholder: 'sk-ant-...',
    helpText: 'Your Anthropic API key.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  google: {
    displayName: 'Google',
    placeholder: 'AIza...',
    helpText: 'Your Google AI Studio API key.',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  openai: {
    displayName: 'OpenAI',
    placeholder: 'sk-...',
    helpText: 'Your OpenAI API key.',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  fireworks: {
    displayName: 'Fireworks AI',
    placeholder: 'fw_...',
    helpText: 'Your Fireworks API key.',
    docsUrl: 'https://fireworks.ai/account/api-keys',
  },
  xai: {
    displayName: 'xAI',
    placeholder: 'xai-...',
    helpText: 'Your xAI API key.',
    docsUrl: 'https://console.x.ai',
  },
};
