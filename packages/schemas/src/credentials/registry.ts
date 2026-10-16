import type { EditionId } from '../edition/descriptor.js';
import { isProviderInEdition, type ProviderDefinition, type ProviderId } from './provider.js';

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_CONTEXT_TOKENS = 32_768;

const THIS_MACHINE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);
/** The host every name for this machine's loopback folds into. */
export const THIS_MACHINE_RUNTIME_HOST = 'this-machine';

/**
 * The runtime a base URL reaches, as one id however it is spelled (Plan 323
 * D7). The host's loopback goes by several names — and a container reaches
 * it as `host.docker.internal` — so two connections that differ only in the
 * name still share one runtime's capacity.
 */
export function localRuntimeId(baseUrl: string | undefined): string {
  const url = new URL(baseUrl || OLLAMA_DEFAULT_BASE_URL);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const host = THIS_MACHINE_HOSTS.has(url.hostname) ? THIS_MACHINE_RUNTIME_HOST : url.hostname;
  return `${host}:${port}`;
}

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
    providerId: 'ollama',
    category: 'llm',
    displayName: 'Ollama',
    description:
      'Models running on this computer through Ollama. Nothing leaves the machine for inference, and nothing is billed.',
    iconName: 'Desktop',
    docsUrl: 'https://docs.ollama.com',
    editions: ['community-local'],
    fields: [
      {
        fieldId: 'base_url',
        label: 'Ollama URL',
        type: 'url',
        required: false,
        defaultValue: OLLAMA_DEFAULT_BASE_URL,
        // Loopback under every name it goes by, and the host as a container
        // reaches it. A runtime on another machine is an operator's decision
        // (CREDENTIAL_EXTRA_BASE_URL_ORIGINS), never a tenant's.
        allowedOrigins: [
          'http://127.0.0.1:11434',
          'http://localhost:11434',
          'http://[::1]:11434',
          'http://host.docker.internal:11434',
        ],
        helpText: 'Where Ollama listens. The default is Ollama on this computer.',
      },
      {
        fieldId: 'token',
        label: 'Token',
        type: 'secret',
        required: false,
        helpText: 'Only for an Ollama behind a proxy that asks for a bearer token.',
      },
      {
        fieldId: 'context_tokens',
        label: 'Context window (tokens)',
        type: 'number',
        required: false,
        placeholder: 'Automatic',
        helpText:
          'Leave empty for the largest window this computer fits, per model. A larger window holds longer conversations and costs memory; a window set here is used as set.',
      },
      {
        fieldId: 'max_parallel',
        label: 'Requests at once',
        type: 'number',
        required: false,
        defaultValue: '1',
        helpText:
          'How many requests this computer serves at the same time. Match OLLAMA_NUM_PARALLEL; each one needs its own context memory.',
      },
      {
        fieldId: 'gpu_memory_gb',
        label: 'GPU memory (GB)',
        type: 'number',
        required: false,
        placeholder: 'Read from this computer',
        helpText:
          'For Ollama on another machine: the GPU memory it has, so each model gets the largest window that fits there. Leave empty for Ollama on this computer, which is read directly.',
      },
      {
        fieldId: 'keep_alive',
        label: 'Keep loaded for',
        type: 'text',
        required: false,
        defaultValue: '30m',
        helpText:
          'How long a model stays in memory after its last request, as Ollama reads it (30m, 2h, -1 for always).',
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

/** The providers an edition offers. */
export function getProvidersForEdition(edition: EditionId): ProviderDefinition[] {
  return PROVIDER_REGISTRY.filter((p) => isProviderInEdition(p, edition));
}

/**
 * Secret fields a credential must carry to be usable. A provider whose only
 * secret is optional (a local runtime's proxy token) is usable with none.
 */
export function getRequiredSecretFieldIds(providerId: string): string[] {
  const provider = registryMap.get(providerId);
  if (!provider) return [];
  return provider.fields.filter((f) => f.type === 'secret' && f.required).map((f) => f.fieldId);
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
