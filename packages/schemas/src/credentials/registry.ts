import type { ProviderDefinition, ProviderId } from './provider.js';

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  // ── LLM Providers ──────────────────────────────────────────────────────
  {
    providerId: 'openai',
    category: 'llm',
    displayName: 'OpenAI',
    description: 'GPT models, DALL-E, Sora, and embeddings',
    iconName: 'OpenAiLogo',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'sk-...',
        helpText: 'Your OpenAI API key from platform.openai.com/api-keys',
      },
      {
        fieldId: 'org_id',
        label: 'Organization ID',
        type: 'text',
        required: false,
        placeholder: 'org-...',
        helpText: 'Optional. Only needed if you belong to multiple organizations.',
      },
    ],
  },
  {
    providerId: 'anthropic',
    category: 'llm',
    displayName: 'Anthropic',
    description: 'Claude models',
    iconName: 'Robot',
    docsUrl: 'https://docs.anthropic.com/en/api',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'sk-ant-...',
        helpText: 'Your Anthropic API key from console.anthropic.com',
      },
    ],
  },
  {
    providerId: 'google',
    category: 'llm',
    displayName: 'Google AI',
    description: 'Gemini models',
    iconName: 'GoogleLogo',
    docsUrl: 'https://ai.google.dev/docs',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'AI...',
        helpText: 'Your Google AI API key from aistudio.google.com',
      },
    ],
  },
  {
    providerId: 'openrouter',
    category: 'llm',
    displayName: 'OpenRouter',
    description: 'Multi-model gateway to 400+ models',
    iconName: 'Graph',
    docsUrl: 'https://openrouter.ai/docs',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'sk-or-...',
        helpText: 'Your OpenRouter API key from openrouter.ai/keys',
      },
    ],
  },
  {
    providerId: 'fireworks',
    category: 'llm',
    displayName: 'Fireworks AI',
    description:
      'Direct high-throughput inference for open-weight models (DeepSeek V4, Kimi K2.6, etc).',
    iconName: 'Flame',
    docsUrl: 'https://docs.fireworks.ai',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'fw_...',
        helpText: 'Your Fireworks API key from fireworks.ai/account/api-keys',
      },
    ],
  },
  {
    providerId: 'xai',
    category: 'llm',
    displayName: 'xAI',
    description: 'Grok chat, image, voice, and transcription models',
    iconName: 'lightning',
    docsUrl: 'https://docs.x.ai',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'xai-...',
        helpText: 'Your xAI API key from console.x.ai',
      },
    ],
  },
  {
    providerId: 'zai',
    category: 'coding',
    displayName: 'Z.ai (GLM)',
    description:
      'Coding-lane backend using your z.ai subscription (GLM-5.3 via the Anthropic-compatible coding endpoint). ' +
      'Not used by chat agents — GLM chat models run via Fireworks. ' +
      'Residency/privacy note: requests leave to z.ai — data does not stay within the EU/GCP boundary.',
    iconName: 'Robot',
    docsUrl: 'https://docs.z.ai',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'zai-...',
        helpText: 'Your z.ai API key from the z.ai console.',
      },
      {
        fieldId: 'base_url',
        label: 'Base URL',
        type: 'url',
        required: false,
        defaultValue: 'https://api.z.ai/api/anthropic',
        allowedOrigins: ['https://api.z.ai'],
        helpText:
          'Anthropic-compatible coding endpoint for GLM-5.3. Defaults to the z.ai coding endpoint.',
      },
    ],
  },

  // ── Media Providers ────────────────────────────────────────────────────
  {
    providerId: 'runware',
    category: 'media',
    displayName: 'Runware',
    description:
      'Aggregated image and video generation — Kling, Seedance, Veo, LTX and others behind one key. ' +
      'Billed per render from prepaid credit, and the amount charged is reported back on every job.',
    iconName: 'film-strip',
    docsUrl: 'https://runware.ai/docs',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        helpText: 'Your Runware API key from the Runware dashboard.',
      },
    ],
  },

  // ── Decision Providers ─────────────────────────────────────────────────
  {
    providerId: 'typesafe',
    category: 'decision',
    displayName: 'TypeSafe',
    description:
      'Jev — typed decisions (a choice, a rubric score, a yes/no) with calibrated confidence, for decision steps in workflows.',
    iconName: 'git-branch',
    docsUrl: 'https://docs.typesafe.ai',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'sk-...',
        helpText: 'Your TypeSafe API key from console.typesafe.ai.',
      },
    ],
  },

  // ── Search Providers ───────────────────────────────────────────────────
  {
    providerId: 'brave',
    category: 'search',
    displayName: 'Brave Search',
    description: 'Web search API',
    iconName: 'MagnifyingGlass',
    docsUrl: 'https://brave.com/search/api/',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        helpText: 'Your Brave Search API subscription token',
      },
    ],
  },
  {
    providerId: 'jina',
    category: 'search',
    displayName: 'Jina AI',
    description: 'Web page reader — extracts clean content from URLs',
    iconName: 'Globe',
    docsUrl: 'https://jina.ai/reader/',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: false,
        helpText: 'Optional. Free tier works without a key; paid tier needs one for higher limits.',
      },
    ],
  },

  // ── Voice Providers ────────────────────────────────────────────────────
  {
    providerId: 'deepgram',
    category: 'voice',
    displayName: 'Deepgram',
    description: 'Speech-to-text (STT)',
    iconName: 'Microphone',
    docsUrl: 'https://developers.deepgram.com/docs',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        helpText: 'Your Deepgram API key from console.deepgram.com',
      },
    ],
  },
  {
    providerId: 'elevenlabs',
    category: 'voice',
    displayName: 'ElevenLabs',
    description: 'Text-to-speech (TTS)',
    iconName: 'SpeakerHigh',
    docsUrl: 'https://elevenlabs.io/docs',
    fields: [
      {
        fieldId: 'api_key',
        label: 'API Key',
        type: 'secret',
        required: true,
        helpText: 'Your ElevenLabs API key from elevenlabs.io',
      },
      {
        fieldId: 'voice_id',
        label: 'Voice ID',
        type: 'text',
        required: false,
        helpText: 'Optional. Default voice used if not specified.',
      },
    ],
  },

  // ── Email Providers ────────────────────────────────────────────────────
  {
    providerId: 'ses',
    category: 'email',
    displayName: 'Amazon SES',
    description: 'Email delivery via SMTP',
    iconName: 'Envelope',
    docsUrl: 'https://docs.aws.amazon.com/ses/',
    fields: [
      {
        fieldId: 'smtp_username',
        label: 'SMTP Username',
        type: 'secret',
        required: true,
        helpText: 'SMTP username (often an IAM access key ID)',
      },
      {
        fieldId: 'smtp_password',
        label: 'SMTP Password',
        type: 'secret',
        required: true,
        helpText: 'SMTP password (IAM secret-derived)',
      },
      {
        fieldId: 'smtp_host',
        label: 'SMTP Host',
        type: 'text',
        required: true,
        placeholder: 'email-smtp.eu-west-1.amazonaws.com',
        helpText: 'SES SMTP endpoint for your region',
      },
      {
        fieldId: 'smtp_port',
        label: 'SMTP Port',
        type: 'number',
        required: false,
        defaultValue: '587',
        helpText: 'SMTP port (default: 587 for STARTTLS)',
      },
      {
        fieldId: 'from_address',
        label: 'From Address',
        type: 'text',
        required: true,
        placeholder: 'noreply@example.com',
        helpText: 'Verified sender email address',
      },
      {
        fieldId: 'from_name',
        label: 'From Name',
        type: 'text',
        required: false,
        placeholder: 'My App',
        helpText: 'Optional display name for the sender',
      },
      {
        fieldId: 'reply_to',
        label: 'Reply-To Address',
        type: 'text',
        required: false,
        helpText: 'Optional reply-to address',
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const registryMap = new Map<string, ProviderDefinition>(
  PROVIDER_REGISTRY.map((p) => [p.providerId, p]),
);

/** Get a provider definition by ID, or undefined if not found. */
export function getProviderDefinition(providerId: string): ProviderDefinition | undefined {
  return registryMap.get(providerId);
}

/** Get all provider definitions. */
export function getAllProviders(): readonly ProviderDefinition[] {
  return PROVIDER_REGISTRY;
}

/** Get provider definitions filtered by category. */
export function getProvidersByCategory(category: string): ProviderDefinition[] {
  return PROVIDER_REGISTRY.filter((p) => p.category === category);
}

/** Get all provider IDs. */
export function getAllProviderIds(): ProviderId[] {
  return PROVIDER_REGISTRY.map((p) => p.providerId);
}

/**
 * Get the secret field IDs for a provider.
 * Used during storage to split secrets from config.
 */
export function getSecretFieldIds(providerId: string): string[] {
  const provider = registryMap.get(providerId);
  if (!provider) return [];
  return provider.fields.filter((f) => f.type === 'secret').map((f) => f.fieldId);
}

/**
 * Get the config (non-secret) field IDs for a provider.
 */
export function getConfigFieldIds(providerId: string): string[] {
  const provider = registryMap.get(providerId);
  if (!provider) return [];
  return provider.fields.filter((f) => f.type !== 'secret').map((f) => f.fieldId);
}

/**
 * Get the required field IDs for a provider (both secret and config).
 */
export function getRequiredFieldIds(providerId: string): string[] {
  const provider = registryMap.get(providerId);
  if (!provider) return [];
  return provider.fields.filter((f) => f.required).map((f) => f.fieldId);
}
