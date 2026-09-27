/**
 * The scope a save sends for a binding.
 *
 * Tenant and space are composed by the API from the authenticated request, so a
 * caller sends neither — a browser cannot know the tenant, and one that guessed
 * was writing a placeholder into stored data.
 *
 * `flowId` is the one member a caller owns, and it must be carried forward
 * explicitly on an edit. The upsert writes `EXCLUDED.scope_json`, so omitting it
 * does not leave the stored value alone: it replaces a binding scoped to one flow
 * with one granted to the entire space, which no dialog asked for and nothing
 * reports.
 */
export function preservedBindingScope(stored?: { scope?: Record<string, unknown> | undefined }): {
  flowId?: string | undefined;
} {
  const flowId = stored?.scope?.['flowId'];
  return typeof flowId === 'string' && flowId.length > 0 ? { flowId } : {};
}
