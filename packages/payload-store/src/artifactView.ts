/**
 * Where a compiled artifact view's bytes go.
 *
 * Every writer that persists a view ref a reader will serve goes through this
 * — the executor's publish and draft paths, and the lazy compile a read
 * performs when neither ran. The applet hermetic capture writes its html
 * through an equivalent content-addressed persistent writer of its own. All of
 * them have to agree on the two decisions below, or the same view is stored
 * two ways and only one of them can be read back.
 *
 * **Content-addressed**, because a step-scoped path is deterministic per
 * (step, attempt, kind) and a view is not written once per step: the same run
 * can publish an artifact and capture its assets. Addressing by content also
 * means two spaces installing the same platform applet share one object.
 *
 * **Persisted**, because the row that names this ref outlives any TTL a
 * backend would otherwise attach — a durable Postgres row pointing at expired
 * bytes is a view that renders until it silently does not.
 */
import { contentAddressForJson } from './store.js';
import type { PayloadStore } from './store.js';
import type { PayloadRef, TenantId } from '@aflow/schemas';

export async function storeArtifactViewHtml(
  store: PayloadStore,
  tenantId: TenantId,
  html: string,
): Promise<PayloadRef> {
  return store.storeContentAddressed({
    tenantId,
    contentHash: contentAddressForJson(html),
    kind: 'artifact_html',
    persist: true,
    data: html,
  });
}

/**
 * An artifact version's source, when it outgrows the inline lane. The same
 * two decisions as the view html and for the same reasons: content-addressed
 * because the identical source installs into every space that takes the
 * listing, persisted because the version row that names the ref has no TTL.
 */
export async function storeArtifactSource(
  store: PayloadStore,
  tenantId: TenantId,
  source: string,
): Promise<PayloadRef> {
  return store.storeContentAddressed({
    tenantId,
    contentHash: contentAddressForJson(source),
    kind: 'artifact_source',
    persist: true,
    data: source,
  });
}
