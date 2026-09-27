/**
 * Applet listing payload — the curated content an `applet` catalog entry
 * carries: the applet definition and the view source that install writes to
 * one ui_artifacts head + version. Distribution is curated-in only (P10):
 * these payloads exist solely in the platform registry, never written from a
 * space.
 */
import { z } from 'zod';
import { AppletDefinitionSchema } from '../applet/definition.js';
import { BundleArtifactSeedSchema } from '../cybernetic/skillBundle.js';
import { AppletLibrarySchema } from '../operations/ui.js';

const seedShape = BundleArtifactSeedSchema.shape;

export const CatalogAppletPayloadSchema = z.object({
  /** Parsed at registry load — `appletKey` must equal the envelope catalogId. */
  appletDefinition: AppletDefinitionSchema,
  /** The view source installed alongside the definition (same cap as bundle artifact seeds). */
  viewSource: z.string().min(1).max(200_000),
  /** Artifact substrate the view compiles under. */
  artifactKind: z.enum(['applet', 'react_tsx']),
  /** Vetted iframe libraries the view needs (applet substrate only). */
  libraries: z.array(AppletLibrarySchema).optional(),
  /** Golden render data for visual QA / Inspector fallback rendering. */
  sampleData: z.record(z.unknown()).optional(),
  /** Design-system catalog pin recorded on the installed artifact head. */
  catalogPin: seedShape.catalogPin,
});
export type CatalogAppletPayload = z.infer<typeof CatalogAppletPayloadSchema>;
