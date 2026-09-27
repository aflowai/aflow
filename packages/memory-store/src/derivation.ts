import type {
  MemoryDocRepository,
  MemoryLinkRepository,
  MemoryDoc,
  MemoryDerivation,
} from '@aflow/database';
import { canonicalizePath } from '@aflow/database';
import type { MemoryDocEmbedJob, TenantId } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { chunkContent, isBinaryDocType, type ContentChunk } from './chunker.js';
import { computeContentHash } from './contentUtils.js';
import { isLinkableDocType } from './linkConstants.js';
import { INDEX_NOTE_PATH, parseIndexNote } from './indexNote.js';
import { parseWikilinks, type ParsedLink } from './links.js';
import { parseFrontmatter, type PropertyValue, type FrontmatterDiagnostic } from './frontmatter.js';
import type { MemoryWriteLogger } from './writeDoc.js';

/**
 * Pure result of scanning a doc's content for chunks, links, and properties.
 * Computed BEFORE the write transaction opens (no IO) so the transaction only
 * carries the SQL work.
 */
export interface PreparedDerivation {
  chunks: ContentChunk[];
  links: ParsedLink[];
  linkReport: { clamped: boolean; scanTruncated: boolean };
  properties: Record<string, PropertyValue>;
  propertyDiagnostics: FrontmatterDiagnostic[];
  /** True when the body opened with a parseable frontmatter block. */
  hadFrontmatter: boolean;
  derivation: MemoryDerivation;
}

/**
 * Scan resolved content into the derived index set: chunks (for embedding/FTS),
 * outgoing wikilinks, and frontmatter properties. PURE — no IO, safe to run
 * before the write transaction.
 *
 * Link + property parsing only runs for linkable doc types (markdown, text,
 * prompt, …). Structural/binary docs get chunks only and empty links/props.
 * The caller must resolve payloadRef content to a string first — binary docs
 * should skip this entirely (their chunks are disabled at the writer).
 */
export function prepareDerivedIndexes(
  content: string,
  docType: string,
  rawPath: string,
  sourceHash?: string,
): PreparedDerivation {
  // The doc row is addressed by its canonical path; wikilink rooting and the
  // /index.md projection must key on the same form so a non-canonical spelling
  // (e.g. `index.md`) cannot land on the canonical row while skipping projection.
  const path = canonicalizePath(rawPath);
  const hash = sourceHash ?? computeContentHash(content);
  const chunks = isBinaryDocType(docType) ? [] : chunkContent(content, docType);

  if (!isLinkableDocType(docType)) {
    return {
      chunks,
      links: [],
      linkReport: { clamped: false, scanTruncated: false },
      properties: {},
      propertyDiagnostics: [],
      hadFrontmatter: false,
      derivation: { schemaVersion: 1, sourceHash: hash },
    };
  }

  const linkParse = parseWikilinks(content, path);
  const frontmatter = parseFrontmatter(content);

  // The space's memory-map note carries a bounded, sanitized projection of its
  // entry lines, persisted at write. The read surface (SpaceContext) reads this
  // projection column — never the note body — so raw note prose can never reach
  // agent context as free-form text. parseIndexNote sanitizes each hook and caps
  // the entry count; this write path only forwards its output.
  const indexProjection = path === INDEX_NOTE_PATH ? parseIndexNote(content) : undefined;

  const propertyWarnings = frontmatter.diagnostics.length;
  const derivation: MemoryDerivation = {
    schemaVersion: 1,
    sourceHash: hash,
    ...(linkParse.clamped ? { linksClamped: true } : {}),
    ...(linkParse.scanTruncated ? { linkScanTruncated: true } : {}),
    ...(propertyWarnings > 0 ? { propertyWarnings } : {}),
    ...(indexProjection ? { indexEntries: indexProjection.entries } : {}),
    ...(indexProjection && indexProjection.omittedEntries > 0
      ? { omittedEntries: indexProjection.omittedEntries }
      : {}),
  };

  return {
    chunks,
    links: linkParse.links,
    linkReport: { clamped: linkParse.clamped, scanTruncated: linkParse.scanTruncated },
    properties: frontmatter.properties,
    propertyDiagnostics: frontmatter.diagnostics,
    hadFrontmatter: frontmatter.hadFrontmatter,
    derivation,
  };
}

/**
 * Chunks-only derivation for the sanctioned NON-linkable structural lane: never
 * parses wikilinks or frontmatter regardless of docType. Structural JSON/skill/
 * workflow docs are addressed by exact path, never searched as link sources, so
 * they carry no links and no properties.
 */
export function prepareStructuralIndexes(
  content: string,
  docType: string,
  sourceHash?: string,
): PreparedDerivation {
  const chunks = isBinaryDocType(docType) ? [] : chunkContent(content, docType);
  return {
    chunks,
    links: [],
    linkReport: { clamped: false, scanTruncated: false },
    properties: {},
    propertyDiagnostics: [],
    hadFrontmatter: false,
    derivation: { schemaVersion: 1, sourceHash: sourceHash ?? computeContentHash(content) },
  };
}

export interface CommitDerivedIndexesContext {
  tenantId: TenantId;
  /** Vestigial — the commit derives from the tx repos + tenantId only. */
  payloadStore?: PayloadStore;
  /** Vestigial — the commit derives from the tx repos + tenantId only. */
  log?: MemoryWriteLogger;
}

/** Up-to-N sample size for ghost targets and property diagnostics in the report. */
const REPORT_SAMPLE_LIMIT = 10;

/**
 * Link derivation summary: resolved vs ghost split (target liveness computed at
 * write against live docs), a capped ghost sample, and whether the source's link
 * set was clamped. Present only for link-source docs.
 */
export interface DerivationLinkReport {
  resolved: number;
  ghostCount: number;
  ghosts: string[];
  clamped: boolean;
}

/**
 * Frontmatter property derivation summary: the stored properties, the full
 * diagnostic count, and a capped diagnostic sample. Present only when the doc
 * carried frontmatter.
 */
export interface DerivationPropertyReport {
  derived: Record<string, PropertyValue>;
  diagnosticCount: number;
  diagnostics: FrontmatterDiagnostic[];
}

/**
 * What the derivation authority actually stored, threaded back to the write
 * handlers so they can echo it into the tool output WITHOUT re-querying. The
 * resolved/ghost split reflects live-doc state at write time.
 */
export interface DerivationReport {
  links?: DerivationLinkReport;
  properties?: DerivationPropertyReport;
  /** Live links already pointing at this path — populated only on first create. */
  incomingLinkCount?: number;
}

/**
 * Build the link half of the report from the doc's just-written outgoing links,
 * whose `resolved` flag the link repo computed against live docs in the space.
 */
function buildLinkReport(
  outgoing: Array<{ targetPath: string; resolved: boolean }>,
  clamped: boolean,
): DerivationLinkReport {
  let resolved = 0;
  const ghosts: string[] = [];
  for (const link of outgoing) {
    if (link.resolved) {
      resolved += 1;
    } else {
      if (ghosts.length < REPORT_SAMPLE_LIMIT) ghosts.push(link.targetPath);
    }
  }
  return {
    resolved,
    ghostCount: outgoing.length - resolved,
    ghosts,
    clamped,
  };
}

function buildPropertyReport(prepared: PreparedDerivation): DerivationPropertyReport {
  return {
    derived: prepared.properties,
    diagnosticCount: prepared.propertyDiagnostics.length,
    diagnostics: prepared.propertyDiagnostics.slice(0, REPORT_SAMPLE_LIMIT),
  };
}

export interface CommitDerivedIndexesResult {
  embedJob: MemoryDocEmbedJob | null;
  report: DerivationReport;
}

/**
 * Decide, per link, which spelling of an extensionless target a document
 * actually answers to. `[[Roadmap]]` means the note at `Roadmap.md`, so the
 * completion stays the default; but a document filed WITHOUT an extension — a
 * rendered image, a clip — is only ever reachable at the spelling it was
 * written under, and completing that one indexes a link to a path that can
 * never exist.
 *
 * One query covers every candidate; a document with no extensionless links pays
 * nothing.
 */
async function resolveSpelledTargets(
  txDocRepo: MemoryDocRepository,
  spaceId: string,
  links: ParsedLink[],
): Promise<ParsedLink[]> {
  if (!links.some((link) => link.spelledTargetPath !== undefined)) return links;

  const candidates = new Set<string>();
  for (const link of links) {
    if (link.spelledTargetPath === undefined) continue;
    candidates.add(link.targetPath);
    candidates.add(link.spelledTargetPath);
  }
  const rows = await txDocRepo.listByPaths(Array.from(candidates), { scope: { spaceId } });
  const live = new Set(rows.map((row) => row.path));

  return links.map((link) => {
    const { spelledTargetPath, ...stored } = link;
    if (spelledTargetPath === undefined) return stored;
    if (live.has(link.targetPath) || !live.has(spelledTargetPath)) return stored;
    return { ...stored, targetPath: spelledTargetPath };
  });
}

/**
 * Commit a prepared derivation into the write transaction: rebuild the doc's
 * chunk set, its outgoing-link set, and its properties/derivation columns. Runs
 * INSIDE the caller's transaction (both repos bound to the same tx) so a
 * content write and its derived indexes commit or roll back together.
 *
 * SQL failures PROPAGATE — there is no swallow. A chunk/link/property insert
 * failure rolls back the whole doc write. Returns the embed job to publish
 * (best-effort, POST-commit; null when nothing needs embedding) alongside the
 * derivation report the write handlers echo into their tool output.
 *
 * `sourceVersion` is stamped onto the stored derivation from the just-put doc's
 * currentVersion — apply-time CAS for backfill compares against it.
 */
export async function commitDerivedIndexes(
  txDocRepo: MemoryDocRepository,
  txLinkRepo: MemoryLinkRepository,
  doc: MemoryDoc,
  prepared: PreparedDerivation,
  ctx: CommitDerivedIndexesContext,
): Promise<CommitDerivedIndexesResult> {
  const derivation: MemoryDerivation = {
    ...prepared.derivation,
    sourceVersion: doc.currentVersion,
  };

  const links = await resolveSpelledTargets(txDocRepo, doc.spaceId, prepared.links);
  await txLinkRepo.replaceLinksForDoc(doc.id, doc.spaceId, links);
  await txDocRepo.updateDerivedFields(doc.id, doc.spaceId, {
    properties: prepared.properties,
    derivation,
  });

  const report: DerivationReport = {};
  if (isLinkableDocType(doc.docType)) {
    const outgoing = await txLinkRepo.getOutgoingLinks(doc.id, doc.spaceId);
    report.links = buildLinkReport(outgoing, prepared.linkReport.clamped);
  }
  if (prepared.hadFrontmatter) {
    report.properties = buildPropertyReport(prepared);
  }

  if (doc.indexingMode === 'disabled') return { embedJob: null, report };

  if (isBinaryDocType(doc.docType)) {
    await txDocRepo.updateDocEmbeddingStatus(doc.id, 'disabled');
    return { embedJob: null, report };
  }

  const latestVersion = await txDocRepo.getLatestVersion(doc.id);
  if (!latestVersion) return { embedJob: null, report };

  await txDocRepo.deleteChunksForDoc(doc.id);

  const chunks = prepared.chunks;
  const hasEmbeddableChunks = chunks.some((c) => c.skipEmbedding !== true);

  await txDocRepo.insertChunks(
    chunks.map((c) => ({
      docId: doc.id,
      docVersionId: latestVersion.id,
      chunkIndex: c.chunkIndex,
      text: c.text,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      ...(c.skipEmbedding === true ? { skipEmbedding: true } : {}),
    })),
  );

  // No embeddable chunks → mark indexed (FTS is auto-generated) and skip the job.
  if (!hasEmbeddableChunks) {
    await txDocRepo.updateDocEmbeddingStatus(doc.id, 'indexed');
    return { embedJob: null, report };
  }

  const resolved = await txDocRepo.resolveEmbeddingModel({
    spaceId: doc.spaceId,
    agentId: doc.agentId ?? undefined,
    pathPrefix: doc.path,
  });

  return {
    embedJob: {
      messageVersion: 1,
      tenantId: ctx.tenantId,
      spaceId: doc.spaceId,
      docId: doc.id,
      docVersionId: latestVersion.id,
      version: doc.currentVersion,
      path: doc.path,
      contentHash: doc.contentHash ?? derivation.sourceHash,
      embeddingModel: resolved.model,
      createdAt: new Date().toISOString(),
    },
    report,
  };
}
