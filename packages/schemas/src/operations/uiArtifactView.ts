import { z } from 'zod';

/**
 * What `GET /v1/ui-artifacts/versions/:versionId/view` answers with. The html
 * rides inside JSON, never as a document — these bytes are generated, and the
 * only place they may execute is the sandboxed frame the client mounts them in.
 */
export const ArtifactVersionViewSchema = z.object({
  versionId: z.string().uuid(),
  html: z.string(),
});
export type ArtifactVersionView = z.infer<typeof ArtifactVersionViewSchema>;

/**
 * Every non-2xx the view endpoint sends. `reason` is present on a
 * `ViewUnavailable` refusal and names which failure it was — a compile error
 * and a missing version are different problems with different fixes.
 */
export const ArtifactVersionViewErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  reason: z.string().optional(),
});
export type ArtifactVersionViewError = z.infer<typeof ArtifactVersionViewErrorSchema>;
