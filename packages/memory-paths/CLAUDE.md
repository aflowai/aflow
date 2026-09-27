# memory-paths — resolver invariant

Resolves `/run/outputs/<toolCallId>/<field>` virtual paths and persistent memory paths
(`resolver.ts`). Consumed by memory `get`/`put` (`content.fromPath`), compute `inputPaths`,
and the orchestrator output summaries (`outputSummary.ts`).

## Invariant — one payload-aware reference semantics (Plan 186)

A reference to a large value must resolve to the **full** value regardless of which syntax
the agent used. The canonical payload-aware traversal is `applyJsonPointer` in
`@aflow/input-resolution` (`stateRefResolver.ts`): it follows, in order, a sibling
`<field>Ref`, a generic `dataRef` fallback, and direct `gs://` / `inline:` values.

✅ **Unified (Plan 186 §5.A, landed).** `resolveVirtualPath` resolves field pointers through
the shared `applyJsonPointer` (with `ctx.payloadStore` wired in), so
`content:{fromPath:"/run/outputs/<id>/data"}`, `inputPaths`, and `{"$ref":"output.<id>/data"}`
all return the **full** body for split-value op outputs (e.g. `api.http.call`'s truncated
`data` + sibling `dataRef`) — identical to stateRefResolver. The old non-payload-aware
`applySimplePointer` is deleted. (This previously silently corrupted a Kaggle dogfood with
cached 1038-byte data stubs.)

**Rule:** do not re-introduce a non-payload-aware pointer function, and do not "fix" a future
split-value op by stripping the inline field at the op handler (that breaks `fromPath` →
`NOT_FOUND` and the `data + statusCode` API shape detector). Share `applyJsonPointer`; don't
fork it.
