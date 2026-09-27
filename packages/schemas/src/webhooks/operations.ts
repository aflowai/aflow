import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { WebhookEndpointStatusSchema } from './webhookEndpoint.js';

// ============================================================================
// api.webhook.upsert
// ============================================================================

export const WebhookUpsertInputSchema = z.object({
  /** Unique name within the space — used as the upsert key. */
  name: z.string().min(1).max(200),

  /** Which flow to trigger when a delivery arrives. Use "self" for the current flow. Each delivery starts a NEW run. */
  flowId: z.union([z.string().min(1), z.literal('self')]),

  /** Optional description of what this webhook receives. */
  description: z.string().max(2000).optional(),

  /**
   * JSONata filter expression evaluated against the incoming payload.
   * If it evaluates to false/null, the delivery is ignored (returns 200 "filtered").
   * Example: `$.action = 'opened'` — only trigger on GitHub PR opened events.
   */
  filterExpression: z.string().optional(),

  /**
   * JSONata input mapping — transforms the webhook payload into flow input.
   * Keys are output field names, values are JSONata expressions.
   * Example: `{ "title": "$.pull_request.title", "repo": "$.repository.full_name" }`
   * If omitted, the raw webhook body is passed as the flow input.
   */
  inputMapping: z.record(z.string()).optional(),

  /** HTTP header name containing the HMAC signature. Default: x-webhook-signature */
  signatureHeader: z.string().min(1).optional(),

  /** HTTP header name containing the delivery ID. Default: x-webhook-id */
  deliveryIdHeader: z.string().min(1).optional(),

  /** HTTP header name containing the timestamp. Default: x-webhook-timestamp */
  timestampHeader: z.string().min(1).optional(),

  /** Replay window in seconds. Deliveries older than this are rejected. Default: 300 (5 min). */
  replayWindowSeconds: z.number().int().positive().optional(),
});
export type WebhookUpsertInput = z.infer<typeof WebhookUpsertInputSchema>;

export const WebhookUpsertOutputSchema = z.object({
  webhookId: z.string().uuid(),
  name: z.string(),
  flowId: z.string(),
  status: WebhookEndpointStatusSchema,
  /** Public URL for external systems to POST to. */
  url: z.string(),
  /**
   * HMAC secret — returned ONLY on creation or when the secret changes.
   * The sender must include HMAC-SHA256(secret, body) in the signature header.
   */
  secret: z.string().optional(),
  created: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WebhookUpsertOutput = z.infer<typeof WebhookUpsertOutputSchema>;

// ============================================================================
// api.webhook.get
// ============================================================================

export const WebhookGetInputSchema = z.object({
  /** Webhook endpoint ID or name. */
  webhookId: z.string().optional(),
  name: z.string().optional(),
});
export type WebhookGetInput = z.infer<typeof WebhookGetInputSchema>;

export const WebhookGetOutputSchema = z.object({
  webhookId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullish(),
  flowId: z.string(),
  status: WebhookEndpointStatusSchema,
  url: z.string(),
  signatureHeader: z.string(),
  deliveryIdHeader: z.string(),
  timestampHeader: z.string(),
  replayWindowSeconds: z.number(),
  filterExpression: z.string().nullish(),
  inputMapping: z.record(z.string()).nullish(),
  lastReceivedAt: z.string().datetime().nullish(),
  lastError: z.string().nullish(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WebhookGetOutput = z.infer<typeof WebhookGetOutputSchema>;

// ============================================================================
// api.webhook.list
// ============================================================================

export const WebhookListInputSchema = z.object({
  status: WebhookEndpointStatusSchema.optional(),
  flowId: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type WebhookListInput = z.infer<typeof WebhookListInputSchema>;

export const WebhookListOutputSchema = z.object({
  webhooks: z.array(WebhookGetOutputSchema),
  totalCount: z.number().int().nonnegative(),
});
export type WebhookListOutput = z.infer<typeof WebhookListOutputSchema>;

// ============================================================================
// api.webhook.delete
// ============================================================================

export const WebhookDeleteInputSchema = z.object({
  /** Webhook endpoint ID or name. */
  webhookId: z.string().optional(),
  name: z.string().optional(),
});
export type WebhookDeleteInput = z.infer<typeof WebhookDeleteInputSchema>;

export const WebhookDeleteOutputSchema = z.object({
  webhookId: z.string().uuid(),
  deleted: z.literal(true),
});
export type WebhookDeleteOutput = z.infer<typeof WebhookDeleteOutputSchema>;

// ============================================================================
// Operation Registrations
// ============================================================================

export const WebhookOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'api',
    group: 'webhook',
    verb: 'upsert',
    name: 'Upsert Webhook Endpoint',
    actionLabel: 'Creating webhook endpoint…',
    semanticDescription:
      'Create or update a webhook endpoint that external systems can POST to, triggering a flow run. ' +
      'Upserts by name within the space. Returns the public URL and HMAC secret (secret shown only on creation). ' +
      'Requires tenant admin or space admin permissions.',
    tags: ['webhook', 'api', 'integration', 'trigger'],
    idempotency: 'idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Create or update a webhook endpoint for external systems to trigger a flow.',
      whenToUse: [
        'Receiving events from GitHub (push, PR opened, etc.)',
        'Receiving events from Stripe (payment, subscription, etc.)',
        'Receiving events from any external system that supports webhooks',
        'Setting up an HTTP trigger for a flow',
      ],
      whenNotToUse: [
        'Starting an agent session directly — use agent.control.delegate or agent.control.run_step',
        'Scheduling an agent on a timer — use agent.schedule.create with cron',
        'Triggering on another agent completing — use agent.schedule.create with onFlowComplete',
      ],
      pitfalls: [
        'The HMAC secret is returned ONLY on creation — save it immediately',
        'The sender must compute HMAC-SHA256(secret, body) and include it in the signature header',
        'Only tenant or space admins can create webhook endpoints',
        'Each delivery starts a NEW independent run of the target flow',
      ],
      minimalExampleInput: {
        name: 'github-push',
        flowId: 'self',
        filterExpression: '$.action = "push"',
        inputMapping: { repo: '$.repository.full_name', branch: '$.ref' },
      },
    },
    inputZod: WebhookUpsertInputSchema,
    outputZod: WebhookUpsertOutputSchema,
  },
  {
    stepType: 'api',
    group: 'webhook',
    verb: 'get',
    name: 'Get Webhook Endpoint',
    actionLabel: 'Fetching webhook endpoint…',
    semanticDescription: 'Get a webhook endpoint by ID or name.',
    tags: ['webhook', 'api'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'Get a webhook endpoint by ID or name.',
      whenToUse: ['Checking the status or configuration of a webhook endpoint'],
      whenNotToUse: ['Listing all webhooks — use api.webhook.list'],
      minimalExampleInput: { name: 'github-push' },
    },
    inputZod: WebhookGetInputSchema,
    outputZod: WebhookGetOutputSchema,
  },
  {
    stepType: 'api',
    group: 'webhook',
    verb: 'list',
    name: 'List Webhook Endpoints',
    actionLabel: 'Listing webhook endpoints…',
    semanticDescription: 'List webhook endpoints in the current space.',
    tags: ['webhook', 'api'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'List webhook endpoints in the space.',
      whenToUse: ['Checking what webhooks are configured in the space'],
      whenNotToUse: ['Getting a specific webhook — use api.webhook.get'],
      minimalExampleInput: {},
    },
    inputZod: WebhookListInputSchema,
    outputZod: WebhookListOutputSchema,
  },
  {
    stepType: 'api',
    group: 'webhook',
    verb: 'delete',
    name: 'Delete Webhook Endpoint',
    actionLabel: 'Deleting webhook endpoint…',
    semanticDescription:
      'Delete a webhook endpoint. The public URL will stop accepting deliveries immediately.',
    tags: ['webhook', 'api'],
    idempotency: 'idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Delete a webhook endpoint.',
      whenToUse: ['Removing a webhook that is no longer needed'],
      whenNotToUse: ['Temporarily disabling — use api.webhook.upsert to pause (not yet supported)'],
      minimalExampleInput: { name: 'github-push' },
    },
    inputZod: WebhookDeleteInputSchema,
    outputZod: WebhookDeleteOutputSchema,
  },
];
