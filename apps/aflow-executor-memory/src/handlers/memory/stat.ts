/**
 * Stat builder for memory operations.
 */
import type { MemoryDoc, MemoryLinkRepository } from '@aflow/database';
import { isLinkableDocType } from '@aflow/memory-store';

interface StatProvenance {
  actor: string;
  sessionId?: string;
  stepExecutionId?: string;
}

interface StatDerivation {
  linksClamped?: boolean;
  linkScanTruncated?: boolean;
  propertyWarnings?: number;
}

function buildProvenance(doc: MemoryDoc): StatProvenance | undefined {
  if (!doc.createdByActor) return undefined;
  const provenance: StatProvenance = { actor: doc.createdByActor };
  if (doc.createdBySessionId) provenance.sessionId = doc.createdBySessionId;
  if (doc.createdByStepExecutionId) provenance.stepExecutionId = doc.createdByStepExecutionId;
  return provenance;
}

function buildDerivationSummary(doc: MemoryDoc): StatDerivation | undefined {
  const d = doc.derivation;
  if (!d) return undefined;
  const summary: StatDerivation = {};
  if (d.linksClamped !== undefined) summary.linksClamped = d.linksClamped;
  if (d.linkScanTruncated !== undefined) summary.linkScanTruncated = d.linkScanTruncated;
  if (d.propertyWarnings !== undefined) summary.propertyWarnings = d.propertyWarnings;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * Build the stat for a real (persisted) document. Link counts require a live
 * space + link repo; backlinks count for any docType, while outgoing
 * link/ghost counts only make sense for docTypes that carry wikilinks.
 */
export async function buildStat(
  doc: MemoryDoc,
  linkRepo: MemoryLinkRepository,
  spaceId: string,
): Promise<Record<string, unknown>> {
  const stat = buildStatBase(doc);

  const backlinkCount = await linkRepo.countBacklinks(doc.path, spaceId);
  stat['backlinkCount'] = backlinkCount;

  if (isLinkableDocType(doc.docType)) {
    const outgoing = await linkRepo.countOutgoing(doc.id, spaceId);
    stat['linkCount'] = outgoing.resolved;
    stat['ghostLinkCount'] = outgoing.ghost;
  }

  return stat;
}

/**
 * Base stat with the row-derived fields only (no link counts). The synthetic
 * virtual-path stat stays count-free by never reaching this graph-aware path.
 */
function buildStatBase(doc: MemoryDoc): Record<string, unknown> {
  const stat: Record<string, unknown> = {
    id: doc.id,
    path: doc.path,
    docType: doc.docType,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    contentHash: doc.contentHash ?? undefined,
    tags: doc.tags,
    version: doc.currentVersion,
    embeddingStatus: doc.embeddingStatus,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };

  if (Object.keys(doc.properties).length > 0) stat['properties'] = doc.properties;

  const provenance = buildProvenance(doc);
  if (provenance) stat['provenance'] = provenance;

  const derivation = buildDerivationSummary(doc);
  if (derivation) stat['derivation'] = derivation;

  return stat;
}
