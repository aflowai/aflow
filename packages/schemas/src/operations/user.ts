import { z } from 'zod';

// ============================================================================

export const GateContextSchema = z.object({
  operationId: z.string().describe('The op being gated (e.g., memory.store.delete).'),
  reason: z
    .string()
    .describe('Why approval was requested (legacy gate context or workflow metadata).'),
  sources: z.array(z.enum(['op', 'binding', 'profile'])).default([]),
  bindingId: z.string().optional(),
  capabilityGroupId: z.string().optional(),
  riskModifiers: z.array(z.string()).default([]),
  /** PayloadRef to the call input being gated. The resolver UI fetches on demand. */
  callInputRef: z.string(),
  /**
   * Deterministic id from {tenantId, runId, originalStepId, operationId, bindingId, callInputHash}.
   * Used for the Redis clearance marker and for cross-tab dedup.
   */
  gateRequestId: z.string(),
});
export type GateContext = z.infer<typeof GateContextSchema>;

export const RelatesToEntrySchema = z.object({
  kind: z.enum(['step', 'proposal', 'binding', 'workflow', 'memory_doc']),
  id: z.string(),
  label: z.string().max(200).optional(),
});
export type RelatesToEntry = z.infer<typeof RelatesToEntrySchema>;

// ============================================================================
// user.interaction.ask - Ask User (Human Input)
// ============================================================================

export const UserRequestInputInputSchema = z.object({
  prompt: z.string().max(10_000).describe('Message shown to the user'),
  inputSchema: z.record(z.unknown()).describe('Expected input format (JSON Schema)').optional(),
  uiHints: z
    .object({
      mode: z.enum(['text', 'textarea', 'form', 'chat', 'choices', 'diff']).optional(),
      placeholder: z.string().max(500).optional(),
      submitLabel: z.string().max(100).optional(),
    })
    .describe('UI display preferences')
    .optional(),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(86400 * 7)
    .nullable()
    .describe('Time limit for user response')
    .optional(),
  defaultOnTimeout: z
    .unknown()
    .describe("Default value if the user doesn't respond in time")
    .optional(),
  gateContext: GateContextSchema.optional(),
  relatesTo: z.array(RelatesToEntrySchema).max(10).optional(),
  placement: z.enum(['chat_inline']).optional(),
});
export type UserRequestInputInput = z.infer<typeof UserRequestInputInputSchema>;

/**
 * Output when step transitions to PAUSED.
 * The actual user input comes when the step is resumed.
 */
export const UserRequestInputOutputSchema = z.object({
  /** Confirmation that input was requested */
  requested: z.literal(true),
  /** Reference to the input request details */
  requestedInputRef: z.string(),
});
export type UserRequestInputOutput = z.infer<typeof UserRequestInputOutputSchema>;

// ============================================================================
// user.interaction.approve - Request Approval
// ============================================================================

export const UserRequestApprovalInputSchema = z.object({
  title: z.string().min(1).max(256).describe('Approval request title (one-line)'),
  description: z.string().min(1).max(10_000).describe('What needs approval (Markdown allowed)'),
  reviewData: z.unknown().describe('Structured data shown for review').optional(),
  approvers: z
    .array(z.string().max(128))
    .min(1)
    .max(50)
    .describe('Who can approve (user IDs or roles)')
    .optional(),
  policy: z
    .object({
      minApprovals: z.number().int().positive().default(1),
      requireAll: z.boolean().default(false),
    })
    .describe('Approval policy settings')
    .optional(),
  uiHints: z
    .object({
      mode: z.enum(['text', 'textarea', 'form', 'chat', 'choices', 'diff']).optional(),
      approveLabel: z.string().max(100).optional(),
      rejectLabel: z.string().max(100).optional(),
    })
    .optional(),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(86400 * 30)
    .nullable()
    .describe('Time limit for approval')
    .optional(),
  defaultOnTimeout: z
    .enum(['approve', 'reject'])
    .describe('Default action if approval times out')
    .optional(),
  gateContext: GateContextSchema.optional(),
  relatesTo: z.array(RelatesToEntrySchema).max(10).optional(),
  placement: z.enum(['chat_inline']).optional(),
});
export type UserRequestApprovalInput = z.infer<typeof UserRequestApprovalInputSchema>;

/**
 * Output when step transitions to PAUSED.
 * The approval result comes when the step is resumed.
 */
export const UserRequestApprovalOutputSchema = z.object({
  /** Confirmation that approval was requested */
  requested: z.literal(true),
  /** Reference to the approval request details */
  requestedInputRef: z.string(),
});
export type UserRequestApprovalOutput = z.infer<typeof UserRequestApprovalOutputSchema>;

// ============================================================================
// Resume Payloads (when user provides input)
// ============================================================================

/**
 * Resume payload for user.interaction.ask.
 */
export const UserInputResumePayloadSchema = z.object({
  /** User-provided input */
  input: z.unknown(),
  /** Timestamp when input was provided */
  providedAt: z.string().datetime(),
  /** User who provided input (if known) */
  providedBy: z.string().optional(),
});
export type UserInputResumePayload = z.infer<typeof UserInputResumePayloadSchema>;

/**
 * Resume payload for user.interaction.approve.
 */
export const UserApprovalResumePayloadSchema = z.object({
  /** Approval decision */
  decision: z.enum(['approved', 'rejected']),
  /** Optional comment from approver */
  comment: z.string().max(2000).optional(),
  /** Timestamp when decision was made */
  decidedAt: z.string().datetime(),
  /** User who made the decision */
  decidedBy: z.string(),
});
export type UserApprovalResumePayload = z.infer<typeof UserApprovalResumePayloadSchema>;

// ============================================================================

export const UserListEmailsInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of emails to return (1–100, default 20)'),
  before: z
    .string()
    .datetime()
    .optional()
    .describe('Return emails sent before this ISO 8601 timestamp (for pagination)'),
});
export type UserListEmailsInput = z.infer<typeof UserListEmailsInputSchema>;

export const SentEmailSummarySchema = z.object({
  stepExecutionId: z.string().uuid().describe('Unique ID of the send_email step execution'),
  runId: z.string().uuid().describe('Run that triggered this email'),
  subject: z.string().describe('Email subject line'),
  recipientEmail: z.string().email().describe('Email address it was sent to'),
  contentFormat: z.enum(['markdown', 'html']).describe('Content format used'),
  sentAt: z.string().datetime().describe('When the email was sent'),
  messageId: z.string().describe('Provider-assigned message ID'),
});
export type SentEmailSummary = z.infer<typeof SentEmailSummarySchema>;

export const UserListEmailsOutputSchema = z.object({
  emails: z.array(SentEmailSummarySchema).describe('Sent emails, newest first'),
  totalReturned: z.number().int().describe('Number of emails in this response'),
  hasMore: z.boolean().describe('Whether more emails exist before the oldest returned'),
});
export type UserListEmailsOutput = z.infer<typeof UserListEmailsOutputSchema>;

// ============================================================================

export const UserSendEmailInputSchema = z.object({
  subject: z.string().min(1).max(200).describe('Email subject line'),
  content: z.string().min(1).max(100_000).describe('Email body content (Markdown or HTML)'),
  contentFormat: z
    .enum(['markdown', 'html'])
    .default('markdown')
    .describe('Content format — Markdown is rendered to HTML, HTML is sanitized'),
});
export type UserSendEmailInput = z.infer<typeof UserSendEmailInputSchema>;

export const UserSendEmailOutputSchema = z.object({
  provider: z.literal('ses_smtp'),
  messageId: z.string().describe('Provider-assigned message ID'),
  recipientUserId: z.string().uuid().describe('Internal user ID of the recipient'),
  recipientEmail: z.string().email().describe('Email address the message was sent to'),
  subject: z.string().describe('Subject line as sent'),
  contentFormat: z.enum(['markdown', 'html']).describe('Content format used'),
  renderedHtmlRef: z.string().optional().describe('PayloadRef to rendered HTML'),
  renderedTextRef: z.string().optional().describe('PayloadRef to plain-text version'),
  sentAt: z.string().datetime().describe('ISO 8601 timestamp of successful send'),
});
export type UserSendEmailOutput = z.infer<typeof UserSendEmailOutputSchema>;

// ============================================================================

import type { OperationRegistration } from '../catalog/operationCatalog.js';

export const UserOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'user',
    group: 'interaction',
    verb: 'ask',
    name: 'Ask User',
    actionLabel: 'Asking user…',
    semanticDescription:
      'Pause flow execution and request input from a user. Supports schema validation, ' +
      'UI mode hints (text, textarea, form, chat), and optional timeout with a default value.',
    tags: ['user', 'interaction', 'pause'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Pause the flow and request free-form or structured input from a user.',
      whenToUse: [
        'Collecting information from a human before continuing a flow',
        'Prompting for clarification when an agent needs more context',
      ],
      whenNotToUse: [
        'Requesting a binary approve/reject decision — use user.interaction.approve instead',
        'Waiting for an external system event — use a webhook or polling step',
      ],
      pitfalls: [
        'The step stays PAUSED until resumed — set timeoutSeconds to avoid indefinite waits',
      ],
      minimalExampleInput: {
        prompt: 'What city should we search for restaurants in?',
      },
    },
    accessMode: 'write',
    inputZod: UserRequestInputInputSchema,
    outputZod: UserRequestInputOutputSchema,
    resumePayloadZod: UserInputResumePayloadSchema,
  },
  {
    stepType: 'user',
    group: 'interaction',
    verb: 'approve',
    name: 'Request Approval',
    actionLabel: 'Waiting for approval…',
    semanticDescription:
      'Pause flow execution and request approval from one or more users. ' +
      'Supports multi-approver policies (min approvals, require all) and optional timeout.',
    tags: ['user', 'interaction', 'pause', 'approval'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Pause the flow and request approval from one or more users.',
      whenToUse: [
        'Gating a destructive or expensive action behind human approval',
        'Implementing a review/sign-off workflow before publishing or deploying',
      ],
      whenNotToUse: [
        'Collecting free-form user input — use user.interaction.ask instead',
        "Automated policy checks that don't need a human — use compute.sandbox.exec or a condition step",
      ],
      pitfalls: [
        'The step stays PAUSED until resumed — set timeoutSeconds and defaultOnTimeout for unattended flows',
        'If approvers list is omitted, any authenticated user can approve',
      ],
      minimalExampleInput: {
        title: 'Deploy to production',
        description: 'Release v2.3.0 to production environment.',
      },
    },
    accessMode: 'write',
    inputZod: UserRequestApprovalInputSchema,
    outputZod: UserRequestApprovalOutputSchema,
    resumePayloadZod: UserApprovalResumePayloadSchema,
  },
  {
    stepType: 'user',
    group: 'notification',
    verb: 'list_emails',
    name: 'List Sent Emails',
    actionLabel: 'Retrieving sent emails…',
    semanticDescription:
      'Retrieve a list of emails previously sent to the current user via user.notification.email. ' +
      'Returns metadata only (subject, timestamp, recipient) — not full email content. ' +
      'Results are scoped to the current user and sorted newest-first.',
    tags: ['user', 'notification', 'email', 'query'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List emails previously sent to the current user.',
      whenToUse: [
        'Checking whether a notification was already sent to avoid duplicates',
        'Summarizing recent email activity for the user',
        'Verifying delivery status of a previous email step',
      ],
      whenNotToUse: [
        'Sending a new email — use user.notification.email instead',
        "Reading another user's emails — this only returns emails sent to the run initiator",
      ],
      pitfalls: [
        'Only returns emails sent via email steps that have been flushed to the database (slight delay after send)',
        'Returns metadata only — use the runId to find the full run context if needed',
      ],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: UserListEmailsInputSchema,
    outputZod: UserListEmailsOutputSchema,
  },
  {
    stepType: 'user',
    group: 'notification',
    verb: 'email',
    name: 'Send Email Notification',
    actionLabel: 'Sending email…',
    semanticDescription:
      'Send an email notification to the human user who started this flow run. ' +
      'The recipient is resolved automatically from the run identity — you cannot specify an arbitrary recipient. ' +
      'Content can be Markdown (recommended) or raw HTML; Markdown is rendered to sanitized HTML with a plain-text fallback.',
    tags: ['user', 'notification', 'email'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Send an email to the user who started this run.',
      whenToUse: [
        'Notifying the user about a completed task, result summary, or important event',
        'Delivering a report, alert, or action item to the user outside the chat UI',
      ],
      whenNotToUse: [
        'Contacting arbitrary people — this only sends to the run initiator',
        'Requesting interactive input or approval — use user.interaction.ask or user.interaction.approve',
        'Sending bulk or marketing emails — this is for transactional notifications only',
      ],
      pitfalls: [
        'This operation is non-idempotent — calling it twice sends two emails',
        'Fails if the run was started by a service principal or API key without a linked human user',
        'Fails if the user has no email on file or is deactivated',
      ],
      minimalExampleInput: {
        subject: 'Your report is ready',
        content:
          '## Summary\n\nYour weekly analytics report has been generated.\n\n- **Total visits**: 12,450\n- **Conversion rate**: 3.2%\n\nCheck your dashboard for the full report.',
      },
    },
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    inputZod: UserSendEmailInputSchema,
    outputZod: UserSendEmailOutputSchema,
  },
];
