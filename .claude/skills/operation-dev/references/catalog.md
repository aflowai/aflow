# Compact Catalog Format

Source of truth: `packages/schemas/src/catalog/compactFormat.ts`

## What agents see

Operations are shown to agents as compact markdown (~30-50 tokens each vs ~750 in full schema):

```markdown
- **api.http.call** — Make an HTTP request. Params: url, method? (GET|POST|PUT|DELETE), headers? ({...}), body?
  ⚠️ `headers` must be a flat string→string object.
```

## Format rules (critical — agent correctness depends on these)

| Rule                                             | Why                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| **Enum values always shown in full** (`a\|b\|c`) | Truncation causes agents to hallucinate invalid values                    |
| **Small objects (<=5 keys) show keys inline**    | Agents need to know the structure: `{inlineText, inlineJson, payloadRef}` |
| **Required = `name`, Optional = `name?`**        | No `?` means agent must provide it                                        |
| **First pitfall shown with warning icon**        | Only if >10 chars, from `usage.pitfalls[0]`                               |
| **Non-idempotent ops get warning**               | For delete/remove verbs                                                   |
| **Internal fields excluded**                     | Fields in `internalFields.input` don't appear in params                   |

## Writing good `usage` fields

```typescript
usage: {
  // Shown in compact catalog — must be unambiguous
  oneLine: 'Store a document in the memory system.',

  // For detailed catalog view
  whenToUse: ['Persist data between runs', 'Store conversation artifacts'],
  whenNotToUse: ['Temporary data within a single run — use state variables'],

  // Shown as ⚠️ in compact format — add when agents repeatedly make mistakes
  pitfalls: ['key must be unique within the space — overwrites existing'],

  // Shown in detailed view
  minimalExampleInput: { key: 'my-doc', content: { inlineText: 'hello' } },
}
```

## When to update compact format

When an agent **misuses an operation** (wrong param name, invalid enum, missing required field):

1. Check what the compact entry shows via `catalog` MCP tool
2. If the format hides or truncates critical info, fix `compactFormat.ts`
3. If the operation's `usage.pitfalls` doesn't cover the mistake, add a pitfall to the registration
4. Don't add workarounds elsewhere — fix the source

## Testing compact output

```bash
yarn catalog:export   # Exports full catalog as JSON
```

Or via MCP: `mcp__aflow-local__catalog` to see what agents actually see.
