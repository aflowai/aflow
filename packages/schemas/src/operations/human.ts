import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { UserApprovalResumePayloadSchema, UserInputResumePayloadSchema } from './user.js';

// ============================================================================
// human.chat.ask — spawn an inline HITL step under the Helmsman session
// ============================================================================

/**
 * Discriminator: `'input'` schedules a child `user.interaction.ask`
 * (collect free-form / structured input), `'approval'` schedules a child
 * `user.interaction.approve` (approve/reject decision with optional
 * reviewData). The handler validates that the right field group is set
 * for the chosen kind and rejects otherwise.
 */
export const HumanChatAskInputSchema = z
  .object({
    kind: z.enum(['input', 'approval']).describe('Which child HITL primitive to schedule.'),

    // ----- input-kind fields (user.interaction.ask payload) -----
    prompt: z
      .string()
      .max(10_000)
      .describe('Question shown to the user. Required when kind="input".')
      .optional(),
    inputSchema: z
      .record(z.unknown())
      .describe('JSON Schema for the expected response shape (input kind).')
      .optional(),

    // ----- approval-kind fields (user.interaction.approve payload) -----
    title: z
      .string()
      .min(1)
      .max(256)
      .describe('One-line approval title. Required when kind="approval".')
      .optional(),
    description: z
      .string()
      .min(1)
      .max(10_000)
      .describe('What needs approval (Markdown allowed). Required when kind="approval".')
      .optional(),
    reviewData: z
      .unknown()
      .describe('Structured data shown for review under the description.')
      .optional(),

    // ----- shared UI hints / timeout -----
    uiHints: z
      .object({
        mode: z.enum(['text', 'textarea', 'form', 'chat', 'choices', 'diff']).optional(),
        submitLabel: z.string().max(100).optional(),
        approveLabel: z.string().max(100).optional(),
        rejectLabel: z.string().max(100).optional(),
        placeholder: z.string().max(500).optional(),
      })
      .optional(),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(86400 * 7)
      .describe('Time limit before the child step auto-fails (max 7 days).')
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'input' && !value.prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`prompt` is required when kind="input".',
        path: ['prompt'],
      });
    }
    if (value.kind === 'approval') {
      if (!value.title) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`title` is required when kind="approval".',
          path: ['title'],
        });
      }
      if (!value.description) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`description` is required when kind="approval".',
          path: ['description'],
        });
      }
    }
  });
export type HumanChatAskInput = z.infer<typeof HumanChatAskInputSchema>;

/**
 * What Helmsman sees as the *tool result* once the operator responds.
 *
 * The runtime route is: human.chat.ask spawns a child user.interaction.*
 * step; the child pauses and waits for the operator; on resume the
 * child's *raw* resume payload becomes the step's `outputRef`
 * ([SessionOrchestrator/index.ts:3268](apps/aflow-orchestrator/src/services/SessionOrchestrator/index.ts:3268)).
 * `applyStepSucceeded` then attributes that raw payload to the
 * human.chat.ask tool call via the `parent:` tag chain — no wrapping
 * step in between.
 *
 * So the catalog-declared output is the *raw* resume payload union (no
 * `{ kind, response }` wrapper) — what the agent actually receives.
 * Agents discriminate by field presence (`input` vs `decision`).
 *
 * Mirrors `AgentRunStepOutputSchema`'s convention: catalog output =
 * what the agent eventually sees; the actual `addStepResult.outputRef`
 * the orchestrator stores for the `human.chat.ask` step itself carries
 * the child's *input* (so the routed scheduleStep feeds it through).
 * Two different layers, two different shapes — both intentional. Phase
 * 5b review feedback: the previous `{ kind, response }` wrapper was
 * never produced by the runtime; the union is the truthful contract.
 */
export const HumanChatAskOutputSchema = z.union([
  UserInputResumePayloadSchema,
  UserApprovalResumePayloadSchema,
]);
export type HumanChatAskOutput = z.infer<typeof HumanChatAskOutputSchema>;

// ============================================================================
// human.action_center.focus — surface an existing item in the active chat
// ============================================================================

export const HumanActionCenterFocusInputSchema = z.object({
  /**
   * Action Center item id. MUST come from a listing operation
   * (typically `proposal.list` returning entries shaped like
   * `proposal:<uuid>`) — never an invented or bare UUID.
   *
   * The prefix discriminates the source: `proposal:` (Coach
   * proposals), `step:` (paused HITL steps), `gate:` (orchestrator
   * synthetic gates), `settings:` (record-backed items). A bare UUID
   * here is the most common hallucination from agents that don't
   * read the catalog usage hints; rejecting it loudly via Zod
   * surfaces a clear error in the tool result, which the agent can
   * then correct on its next turn (refetch from `proposal.list`,
   * pass the prefixed id verbatim).
   */
  itemId: z
    .string()
    .min(1)
    .max(256)
    .regex(
      /^(proposal|step|gate|settings):.+/,
      'itemId must be the prefixed id returned by a listing op (e.g. "proposal:<uuid>" from proposal.list, "step:<uuid>" from a paused HITL step). A bare UUID is never a valid Action Center item id — call proposal.list (or the relevant listing) and pass the `id` field verbatim. If no such item exists yet, switch to human.chat.ask instead.',
    ),
  /**
   * Optional reason copy surfaced to the operator ("Coach is asking you to
   * ratify this before continuing"). Kept short — anything longer belongs
   * in the original item's description.
   */
  reason: z.string().max(280).optional(),
});
export type HumanActionCenterFocusInput = z.infer<typeof HumanActionCenterFocusInputSchema>;

export const HumanActionCenterFocusOutputSchema = z.object({
  /**
   * `true` when the SSE event was published. The client may or may not
   * be connected — `acknowledged` is a publish receipt, not a delivery
   * confirmation. Helmsman should follow up if the item stays unresolved.
   */
  acknowledged: z.boolean(),
  itemId: z.string(),
  /**
   * Contextual next-step hint for the agent. The handler populates this
   * verbatim on every success so the agent learns the right follow-up
   * behaviour at the moment of action, not via a separate prompt section.
   * Typical content: "The operator now sees the card in chat — end your
   * turn and wait for their decision; they will resume this session."
   */
  note: z.string().optional(),
});
export type HumanActionCenterFocusOutput = z.infer<typeof HumanActionCenterFocusOutputSchema>;

// ============================================================================
// Operation Registrations
// ============================================================================

export const HumanOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'human',
    group: 'chat',
    verb: 'ask',
    name: 'Ask user in chat',
    actionLabel: 'Asking the user…',
    semanticDescription:
      "Pause and ask the operator a fresh question — when nothing in the Action Center already covers what you need. The step stays PAUSED until they respond and the response becomes this tool's result. Discriminator: if an item with a real id exists (e.g. from `proposal.list`), use `human.action_center.focus` instead so the platform-owned UI surfaces; only use this tool when YOU are authoring the question from scratch.",
    tags: ['human', 'hitl', 'pause'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Author a fresh question (input or approval) and pause until the operator responds.',
      whenToUse: [
        "No matching Action Center item exists, and you're authoring the question yourself",
      ],
      whenNotToUse: [
        'A Coach proposal / paused gate / record already covers it → human.action_center.focus',
        'Workflow-authored HITL belongs inside the workflow on a user.interaction.* step, not here',
      ],
      pitfalls: [
        'Step stays PAUSED until resume — set `timeoutSeconds` if unattended',
        'kind="approval" requires title+description; kind="input" requires prompt',
      ],
      minimalExampleInput: {
        kind: 'input',
        prompt: 'Which dataset should I analyse?',
        inputSchema: { type: 'string', enum: ['sales', 'returns', 'inventory'] },
        uiHints: { mode: 'choices', submitLabel: 'Use this dataset' },
      },
    },
    accessMode: 'write',
    inputZod: HumanChatAskInputSchema,
    outputZod: HumanChatAskOutputSchema,
  },
  {
    stepType: 'human',
    group: 'action_center',
    verb: 'focus',
    name: 'Focus Action Center item',
    actionLabel: 'Drawing attention…',
    semanticDescription:
      "Surface an EXISTING Action Center item to the operator (Coach proposal, paused HITL step, gate, record). The platform owns the rendering — you do NOT author title/description/buttons; you only point at the item by its prefixed id. The `itemId` MUST come from a listing op (proposal.list, etc.) — never invent or fabricate one. Discriminator: if you don't already have an id from a real listing, this is the wrong tool — use `human.chat.ask` to author a fresh question instead.",
    tags: ['human', 'action_center', 'notification'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Point the chat at an existing Action Center item — id MUST come from a listing op.',
      whenToUse: [
        'You already have an itemId from a real listing (proposal.list returned it, a paused gate exposed it)',
      ],
      whenNotToUse: [
        "You don't have an id from a listing — DO NOT invent one. Use human.chat.ask",
        'The thing you want is a workflow run resume — that flows through the workflow.run.resume path',
      ],
      pitfalls: [
        'Bare UUIDs are rejected at parse time; ids are prefixed (proposal:/step:/gate:/settings:)',
        '`acknowledged: true` is a publish receipt, not a delivery / resolution confirmation',
      ],
      minimalExampleInput: {
        itemId: 'proposal:7f2d3a16-9b51-4e7f-a3c5-3bf3a3f04d10',
      },
    },
    accessMode: 'read',
    inputZod: HumanActionCenterFocusInputSchema,
    outputZod: HumanActionCenterFocusOutputSchema,
  },
];
