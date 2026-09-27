import { z } from 'zod';

// ---------------------------------------------------------------------------
// Provider taxonomy
// ---------------------------------------------------------------------------

export const ProviderCategorySchema = z.enum([
  'llm',
  'coding',
  'media',
  'decision',
  'search',
  'voice',
  'email',
]);
export type ProviderCategory = z.infer<typeof ProviderCategorySchema>;

/**
 * `llm` is the agent lane (chat-model credentials); `coding` is the coding
 * lane's backend (Plan 219 `backendProvider`) — a provider in one lane is
 * never offered by the other's surfaces. `media` is the render lane: it buys
 * images and video and drives no agent, so a key here can never satisfy the
 * requirement that a tenant have a chat model. `decision` is the same: a
 * decision model answers typed questions for a workflow step and writes no
 * text, so it can never stand in for a chat model either.
 */
export const PROVIDER_CATEGORY_ORDER: readonly ProviderCategory[] = [
  'llm',
  'coding',
  'media',
  'decision',
  'search',
  'voice',
  'email',
];

export const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  llm: 'Agent Models',
  coding: 'Coding',
  media: 'Image & Video',
  decision: 'Decisions',
  search: 'Search',
  voice: 'Voice',
  email: 'Email',
};

export const PROVIDER_CATEGORY_DESCRIPTIONS: Record<ProviderCategory, string> = {
  llm: 'Chat models for your agents — at least one connected provider is required.',
  coding:
    'Optional. Backend for the coding lane (z.ai subscription or Anthropic key). Only needed by coding skills.',
  media: 'Optional. Dedicated image and video generation routes.',
  decision:
    'Optional. Decision models that route, gate and score inside workflows with calibrated confidence.',
  search: 'Optional. Web search and page fetch for skills that use them.',
  voice: 'Optional. Speech-to-text and text-to-speech for voice sessions.',
  email: 'Optional. Outbound email notifications.',
};

export const ProviderIdSchema = z.enum([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'fireworks',
  'xai',
  'zai',
  'runware',
  'typesafe',
  'brave',
  'jina',
  'deepgram',
  'elevenlabs',
  'ses',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

// ---------------------------------------------------------------------------
// Credential scoping
// ---------------------------------------------------------------------------

export const CredentialScopeSchema = z.enum(['user', 'space', 'tenant']);
export type CredentialScope = z.infer<typeof CredentialScopeSchema>;

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export const CredentialFieldTypeSchema = z.enum(['secret', 'text', 'url', 'number']);
export type CredentialFieldType = z.infer<typeof CredentialFieldTypeSchema>;

export const CredentialFieldSchema = z.object({
  fieldId: z.string(),
  label: z.string(),
  type: CredentialFieldTypeSchema,
  required: z.boolean(),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
  /** Only for non-secret fields. */
  defaultValue: z.string().optional(),
  /**
   * Origins a `url` field may point at. A credential's config is writable
   * WITHOUT re-entering its secret, so an unconstrained URL field is a way to
   * redirect a key at a host of the writer's choosing — and requiring the secret
   * back would only stop a writer who lacks it, not one who was tricked or who
   * mistyped. Constraining the destination covers both.
   *
   * A deployment that genuinely needs another origin (a corporate gateway, a
   * self-hosted proxy) extends this through operator configuration, so the
   * decision sits with whoever runs the deployment rather than with a tenant.
   */
  allowedOrigins: z.array(z.string()).optional(),
});
export type CredentialField = z.infer<typeof CredentialFieldSchema>;

/**
 * Whether a value is acceptable for a field that constrains its origins.
 * Fields without `allowedOrigins`, and non-URL values, are not this check's
 * business — it answers only "may a secret be sent here".
 */
export function isAllowedFieldOrigin(
  field: CredentialField,
  value: string,
  extraOrigins: readonly string[] = [],
): boolean {
  if (!field.allowedOrigins || field.allowedOrigins.length === 0) return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  // An embedded authority is never wanted where a secret is sent — it survives
  // into logs and remotes, and it is not what an operator means to configure.
  if (parsed.username !== '' || parsed.password !== '') return false;
  return field.allowedOrigins.includes(parsed.origin) || extraOrigins.includes(parsed.origin);
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

export const ProviderDefinitionSchema = z.object({
  providerId: ProviderIdSchema,
  category: ProviderCategorySchema,
  displayName: z.string(),
  description: z.string(),
  iconName: z.string(),
  docsUrl: z.string().url().optional(),
  fields: z.array(CredentialFieldSchema),
});
export type ProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;

// ---------------------------------------------------------------------------
// Credential metadata (API response — values NEVER included)
// ---------------------------------------------------------------------------

export const CredentialMetaSchema = z.object({
  id: z.string().uuid(),
  providerId: ProviderIdSchema,
  scope: CredentialScopeSchema,
  scopeId: z.string().uuid(),
  label: z.string().nullable(),
  configJson: z.record(z.unknown()),
  hasSecrets: z.boolean(),
  status: z.enum(['active', 'error']),
  lastValidatedAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CredentialMeta = z.infer<typeof CredentialMetaSchema>;

// ---------------------------------------------------------------------------
// Credential source (for usage/cost attribution)
// ---------------------------------------------------------------------------

export const CredentialSourceSchema = z.object({
  providerId: z.string(),
  scope: CredentialScopeSchema,
  scopeId: z.string(),
  credentialId: z.string(),
});
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;

// ---------------------------------------------------------------------------
// Credential status (resolution preview)
// ---------------------------------------------------------------------------

export const CredentialStatusSchema = z.object({
  providerId: z.string(),
  resolved: z.boolean(),
  resolvedScope: CredentialScopeSchema.nullable(),
  status: z.enum(['active', 'error']).nullable(),
  lastErrorCode: z.string().nullable(),
  availableScopes: z.array(
    z.object({
      scope: CredentialScopeSchema,
      scopeId: z.string(),
      status: z.enum(['active', 'error']),
    }),
  ),
});
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;
