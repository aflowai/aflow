import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import {
  appletInstances,
  createTenantContext,
  uiArtifacts,
  uiArtifactVersions,
  withTenantSchema,
} from '@aflow/database';
import { parsePayloadRef, type TenantId } from '@aflow/schemas';
import {
  contentAddressForJson,
  storeArtifactViewHtml,
  type PayloadStore,
} from '@aflow/payload-store';
import { buildAppletViewHtml, findUnpinnedExternalRef } from '@aflow/ui-artifact-compiler';

/**
 * The space an applet instance lives in — null when no such instance exists
 * in the tenant. Instance routes and the realtime topic are addressed by
 * instanceId, so the space every access check needs is resolved from the
 * instance row, never taken from the caller.
 */
export async function resolveAppletInstanceSpaceId(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  instanceId: string,
): Promise<string | null> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({ spaceId: appletInstances.spaceId })
      .from(appletInstances)
      .where(eq(appletInstances.id, instanceId))
      .limit(1),
  );
  return rows[0]?.spaceId ?? null;
}

/**
 * The space an artifact version belongs to, through the artifact that owns it.
 * A version is the immutable thing a view URL can name — an instance is not,
 * because an upgrade repins it to another version and the URL would go on
 * naming the old bytes.
 */
export async function resolveArtifactVersionSpaceId(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  artifactVersionId: string,
): Promise<string | null> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({ spaceId: uiArtifacts.spaceId })
      .from(uiArtifactVersions)
      .innerJoin(uiArtifacts, eq(uiArtifacts.id, uiArtifactVersions.artifactId))
      .where(eq(uiArtifactVersions.id, artifactVersionId))
      .limit(1),
  );
  return rows[0]?.spaceId ?? null;
}

/**
 * The pinned view's compiled-HTML payload ref — null until something has
 * compiled the version (compilation is lazy; render and publish hydrate it).
 */
/**
 * Why an applet instance has no view to render.
 *
 * Every one of these was a bare `null` before, and the surface rendered the
 * same empty state for all of them — "does not expose its view yet", which
 * reads as *not published* whichever of these actually happened. A compile
 * error and a view too large to store are different problems with different
 * fixes, and neither is the one that message describes.
 */
export type AppletViewUnavailableReason =
  | 'version_missing'
  | 'not_an_applet'
  | 'source_unavailable'
  | 'compile_failed'
  | 'external_reference';

export interface AppletViewUnavailable {
  reason: AppletViewUnavailableReason;
  /** What to tell whoever is looking at the empty frame. */
  detail: string;
}

/**
 * A serveable view: the digest of its bytes (the validator a response carries),
 * plus either the bytes themselves — already in hand from a fresh compile, a
 * legacy inline ref, or a run-layout retrieve — or a stored ref the caller may
 * defer retrieving until the validator has missed.
 */
export type AppletViewResolution =
  | { contentHash: string; html?: string; htmlRef?: string; unavailable?: undefined }
  | {
      contentHash?: undefined;
      html?: undefined;
      htmlRef?: undefined;
      unavailable: AppletViewUnavailable;
    };

/**
 * The rows written before views were stored hold `inline:` refs of the RAW
 * html, base64 and nothing else — the store's own inline codec JSON-encodes,
 * so `retrieve` throws on them. The old reader was the browser, whose decoder
 * fell back to the raw string; this is that fallback, server-side, so every
 * view served before the migration stays serveable after it.
 */
export function decodeLegacyInlineHtml(ref: string): string | null {
  if (!ref.startsWith('inline:')) return null;
  const decoded = Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8');
  if (decoded.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return decoded;
  }
}

/**
 * What a version yields before anything is stored: a ref that is already on the
 * row, freshly built html that is not yet anywhere, or a refusal.
 */
export type AppletViewDecision =
  | { htmlRef: string; html?: undefined; unavailable?: undefined }
  | { htmlRef?: undefined; html: string; unavailable?: undefined }
  | { htmlRef?: undefined; html?: undefined; unavailable: AppletViewUnavailable };

const unavailable = (reason: AppletViewUnavailableReason, detail: string): AppletViewDecision => ({
  unavailable: { reason, detail },
});

/**
 * The version row the view is built from, as the decision needs it. Named
 * separately from the query so the decision can be exercised without a
 * database — every branch below is a property of these three fields and the
 * compiler's answer, and none of them is I/O.
 */
export interface AppletViewVersionRow {
  htmlRef: string | null;
  sourceRef: string;
  kind: string;
}

/**
 * Whether this version yields a view, and what to say when it does not. Pure
 * apart from the compile and the injected source read: the caller persists a
 * resolved ref, and nothing here writes. A source past the inline cap lives in
 * the payload store, so the caller hands in the loader that can reach it —
 * without one, a stored source is a named refusal rather than a silent miss.
 */
export async function decideAppletView(
  row: AppletViewVersionRow,
  loadStoredSource?: (sourceRef: string) => Promise<string | null>,
): Promise<AppletViewDecision> {
  if (row.htmlRef !== null) return { htmlRef: row.htmlRef };

  // Seed and Store installs write versions with no html (the executor's
  // publish-time capture never ran for them), and nothing else ever renders
  // an applet — so the view would be permanently unavailable. A library-free
  // applet wraps hermetically by construction, so hydrate it here on first
  // read and persist the result for every later reader.
  if (row.kind !== 'applet') {
    return unavailable(
      'not_an_applet',
      `This artifact is a ${row.kind}, which has no applet view.`,
    );
  }
  let source: string;
  if (row.sourceRef.startsWith('inline:')) {
    try {
      const decoded = Buffer.from(row.sourceRef.slice('inline:'.length), 'base64').toString('utf8');
      const parsed: unknown = JSON.parse(decoded);
      source = typeof parsed === 'string' ? parsed : decoded;
    } catch {
      return unavailable(
        'source_unavailable',
        'This version’s stored source could not be decoded.',
      );
    }
  } else {
    if (loadStoredSource === undefined) {
      return unavailable(
        'source_unavailable',
        'This version stores its source outside the record, which the view path cannot read.',
      );
    }
    let stored: string | null;
    try {
      stored = await loadStoredSource(row.sourceRef);
    } catch {
      stored = null;
    }
    if (stored === null) {
      return unavailable(
        'source_unavailable',
        'This version’s stored source could not be read back.',
      );
    }
    source = stored;
  }
  const built = await buildAppletViewHtml(source, []);
  if (built.html === null) {
    const said = built.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.message)
      .join('; ');
    return unavailable(
      'compile_failed',
      said.length > 0 ? `The view did not compile: ${said}` : 'The view did not compile.',
    );
  }
  // An external URL the wrap did not pin means this version carries libraries
  // no capture inlined — leave it lazy rather than publish a leaky view.
  const external = findUnpinnedExternalRef(built.html);
  if (external !== null) {
    return unavailable(
      'external_reference',
      `The view reaches ${external}, which the wrap did not pin — it is withheld rather than served with a hole in it.`,
    );
  }
  return { html: built.html };
}

export async function resolveAppletViewHtmlRef(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  artifactVersionId: string,
  payloadStore: PayloadStore,
): Promise<AppletViewResolution> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({
        htmlRef: uiArtifactVersions.htmlRef,
        sourceRef: uiArtifactVersions.sourceRef,
        kind: uiArtifacts.kind,
      })
      .from(uiArtifactVersions)
      .innerJoin(uiArtifacts, eq(uiArtifacts.id, uiArtifactVersions.artifactId))
      .where(eq(uiArtifactVersions.id, artifactVersionId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) {
    return {
      unavailable: {
        reason: 'version_missing',
        detail: 'This instance points at an artifact version that no longer exists in this tenant.',
      },
    };
  }
  const decided = await decideAppletView(row, async (sourceRef) => {
    const stored = await payloadStore.retrieve(sourceRef);
    return typeof stored === 'string' ? stored : null;
  });
  if (decided.unavailable !== undefined) return { unavailable: decided.unavailable };

  if (decided.htmlRef !== undefined) {
    const ref = decided.htmlRef;
    if (ref.startsWith('inline:')) {
      const html = decodeLegacyInlineHtml(ref);
      if (html === null) {
        return {
          unavailable: {
            reason: 'source_unavailable',
            detail: 'This version’s stored view could not be decoded.',
          },
        };
      }
      return { html, contentHash: contentAddressForJson(html) };
    }
    // A content-layout ref carries its own digest, so the validator is free
    // and the bytes can wait for a validator miss. Anything else has to be
    // read before it can be described.
    const parsed = parsePayloadRef(ref);
    if (parsed !== null && parsed.form === 'object' && parsed.layout === 'content') {
      return { htmlRef: ref, contentHash: parsed.contentHash };
    }
    let stored: unknown;
    try {
      stored = await payloadStore.retrieve(ref);
    } catch {
      stored = null;
    }
    if (typeof stored !== 'string') {
      return {
        unavailable: {
          reason: 'source_unavailable',
          detail: 'This version’s stored view could not be read back.',
        },
      };
    }
    return { html: stored, contentHash: contentAddressForJson(stored) };
  }

  // Freshly built: store it, then record the ref under the same `isNull` guard
  // a concurrent reader raced for. Storing is idempotent — the address is the
  // content — so two readers building the same view write the same object.
  const htmlRef = await storeArtifactViewHtml(payloadStore, tenantId, decided.html);
  await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .update(uiArtifactVersions)
      .set({ htmlRef })
      .where(and(eq(uiArtifactVersions.id, artifactVersionId), isNull(uiArtifactVersions.htmlRef))),
  );
  return { htmlRef, html: decided.html, contentHash: contentAddressForJson(decided.html) };
}
