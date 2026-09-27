import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

export const WebhookEndpointStatusSchema = z.enum([
  'active', // Accepting deliveries
  'paused', // Temporarily disabled
]);
export type WebhookEndpointStatus = z.infer<typeof WebhookEndpointStatusSchema>;

// ============================================================================
// WebhookEndpoint Record (API response shape — never includes the raw secret)
// ============================================================================

export const WebhookEndpointSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('platform-role'), systemRole: z.string() }),
    z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
  ]),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),

  // Header configuration (which headers the sender uses)
  signatureHeader: z.string().min(1),
  deliveryIdHeader: z.string().min(1),
  timestampHeader: z.string().min(1),

  // Replay / dedup policy
  // Bounded because the window sizes the dedup retention and, at the top of
  // its old range, disabled freshness outright — a stamp is always inside a
  // 68-year window. A day is longer than any sender's retry schedule.
  replayWindowSeconds: z.number().int().positive().max(86_400),
  requireDeliveryId: z.boolean(),

  // Input transformation (JSONata expressions)
  inputMapping: z.record(z.string()).nullish(),
  filterExpression: z.string().nullish(),

  status: WebhookEndpointStatusSchema,

  // Public URL for external systems to POST to (computed, returned on create)
  url: z.string().optional(),

  // Lifecycle tracking
  lastReceivedAt: z.string().datetime().nullish(),
  lastError: z.string().nullish(),

  createdBy: z.string().nullish(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

// ============================================================================
// Create / Update Bodies
// ============================================================================

export const CreateWebhookEndpointBodySchema = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('platform-role'), systemRole: z.string().min(1).max(64) }),
    z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
  ]),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),

  signatureHeader: z.string().min(1).default('x-webhook-signature'),
  deliveryIdHeader: z.string().min(1).default('x-webhook-id'),
  timestampHeader: z.string().min(1).default('x-webhook-timestamp'),

  replayWindowSeconds: z.number().int().positive().max(86_400).default(300),
  requireDeliveryId: z.boolean().default(false),

  inputMapping: z.record(z.string()).optional(),
  filterExpression: z.string().optional(),
});
export type CreateWebhookEndpointBody = z.infer<typeof CreateWebhookEndpointBodySchema>;

export const UpdateWebhookEndpointBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  target: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('platform-role'), systemRole: z.string().min(1).max(64) }),
      z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
    ])
    .optional(),
  status: WebhookEndpointStatusSchema.optional(),

  signatureHeader: z.string().min(1).optional(),
  deliveryIdHeader: z.string().min(1).optional(),
  timestampHeader: z.string().min(1).optional(),

  replayWindowSeconds: z.number().int().positive().max(86_400).optional(),
  requireDeliveryId: z.boolean().optional(),

  inputMapping: z.record(z.string()).nullish(),
  filterExpression: z.string().nullish(),

  /** When true, generates a new HMAC secret and returns it once in the response. */
  regenerateSecret: z.boolean().optional(),
});
export type UpdateWebhookEndpointBody = z.infer<typeof UpdateWebhookEndpointBodySchema>;

// ============================================================================
// Creation response (includes plaintext secret — returned ONCE)
// ============================================================================

export const WebhookEndpointCreatedSchema = WebhookEndpointSchema.extend({
  /** Plaintext HMAC secret — shown only on creation or secret regeneration. */
  secret: z.string(),
});
export type WebhookEndpointCreated = z.infer<typeof WebhookEndpointCreatedSchema>;
