# Operation Registry

Source of truth: `packages/schemas/src/catalog/registry.ts`, `packages/schemas/src/catalog/operationId.ts`

## Operation ID convention

All IDs follow: `{stepType}.{group}.{verb}` — built via `buildOperationId(stepType, group, verb)`.

- **stepType**: `ai`, `api`, `compute`, `eval`, `flow`, `guardrail`, `mcp`, `memory`, `platform`, `search`, `ui`, `user`
- **group**: snake_case category (e.g., `text`, `store`, `http`, `manage`, `control`)
- **verb**: snake_case action (e.g., `generate`, `call`, `put`, `get`, `turn`)
- Group can be null for ungrouped ops: `memory.query` (2-segment)

Examples: `ai.text.generate`, `api.http.call`, `memory.store.put`, `flow.control.run_step`, `ai.agent.turn`

**Never hand-write an operationId** — always use `buildOperationId()`.

## Registration entry — all fields

```typescript
{
  // Structural (operationId computed from these)
  stepType: 'ai',
  group: 'text',           // null if no group
  verb: 'generate',

  // Display
  name: 'Generate Text',
  actionLabel: 'Generating text...',    // Activity indicator in UI
  semanticDescription: 'Generate text using an LLM...',
  tags: ['generation'],

  // Schema contracts
  inputZod: AiGenerateInputSchema,      // Required
  outputZod: AiGenerateOutputSchema,    // Required if output produced
  stepConfigZod?: AgentStepConfigSchema, // Optional per-step config
  resumePayloadZod?: SomeSchema,        // Optional for pausable ops

  // Implementation properties
  idempotency: 'non_idempotent',   // 'idempotent' | 'non_idempotent'
  mutates: false,                  // Side effects on external state?

  // Access control
  capabilityGroupId: 'ai.generate',
  accessMode: 'read',             // 'read' | 'write'
  riskModifiers?: ['destructive'],
  privileged?: true,              // System-only (hidden from agents)
  internal?: true,                // Hidden from catalog entirely

  // Agent help (Plan 83)
  usage: {
    oneLine: 'Generate text from a prompt using an LLM.',
    whenToUse: ['Need free-form text output'],
    whenNotToUse: ['Need structured JSON — use ai.text.generate_json'],
    pitfalls: ['Must provide model field'],
    minimalExampleInput: { model: 'sonnet', prompt: 'Hello' },
  },

  // Field hiding
  internalFields?: {
    input: ['tools', 'toolChoice', 'messages'],  // Hidden from agents
    output: ['toolCalls'],
  },

  // Validation control
  skipInputValidation?: true,     // Rare — skip Zod validation
}
```

## Key functions

- `getAllOperations()` — Map of all operations
- `getOperation(operationId)` — Single lookup
- `getOperationsByStepType(stepType)` — Filter by step type
- `getOperationsByGroupId(groupId)` — Filter by qualified group (e.g., `'ai.text'`)
- `isPrivilegedOperation(operationId)` — Check system-only
- `getOperationCapability(operationId)` — RBAC capability info

## Common mistakes

- **Hand-writing operationId**: Always compute via `buildOperationId()`
- **Missing `usage.pitfalls`**: When agents misuse an op repeatedly, add a pitfall
- **Not marking `internalFields`**: Orchestrator-managed fields (history, tools, messages) must be hidden
- **Wrong `idempotency`**: Reads are idempotent, writes/creates are not
- **Missing `outputZod`**: Required for any operation that produces output
