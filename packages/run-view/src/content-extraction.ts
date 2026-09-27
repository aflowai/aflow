import type { StateValueRef } from './types.js';

// ============================================================================
// Media Item Types — the renderable half of a MediaAsset
// ============================================================================

/**
 * A generated asset as the chat renders it. The bytes never travel in a step
 * output, so `docId` is the whole source: it addresses the authenticated ranged
 * byte read the player streams from.
 */
export interface MediaItem {
  kind: 'image' | 'video';
  mimeType: string;
  docId: string;
  revisedPrompt?: string;
}

function toMediaItem(item: unknown): MediaItem | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  if (obj.kind !== 'image' && obj.kind !== 'video') return null;
  if (typeof obj.mimeType !== 'string' || typeof obj.docId !== 'string') return null;
  return {
    kind: obj.kind,
    mimeType: obj.mimeType,
    docId: obj.docId,
    ...(typeof obj.revisedPrompt === 'string' ? { revisedPrompt: obj.revisedPrompt } : {}),
  };
}

/**
 * Detect renderable assets in a step output — the `assets` array every media
 * operation returns (ai.media.image, ai.media.video, ai.media.animate, …).
 */
export function extractMediaItems(data: unknown): MediaItem[] | null {
  if (!data || typeof data !== 'object') return null;

  const assets = (data as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return null;

  const items: MediaItem[] = [];
  for (const asset of assets) {
    const item = toMediaItem(asset);
    if (item !== null) items.push(item);
  }
  return items.length > 0 ? items : null;
}

// ============================================================================
// Display content extraction
// ============================================================================

export interface DisplayContent {
  text: string;
  richData?: unknown;
  mediaItems?: MediaItem[];
  /** When set, the content is a truncated preview and the full payload can be lazy-loaded */
  payloadRef?: string;
  /** Semantic type hint for UI rendering (e.g. 'compute_result', 'guardrail_policy') */
  semanticType?: string;
}

/**
 * Extract displayable content from a StateValueRef (inline or ref with preview).
 * Returns { text, richData, mediaItems, payloadRef } — richData is set for
 * objects/JSON that should render via the interactive JsonViewer. mediaItems
 * is set when the output contains generated images/videos. payloadRef is set
 * when the value is stored externally and can be lazy-loaded.
 */
export function extractDisplayContent(
  valueRef: StateValueRef | null | undefined,
): DisplayContent | null {
  if (!valueRef) return null;

  const st = valueRef.semanticType;
  const stProp: { semanticType?: string } = st ? { semanticType: st } : {};

  if (valueRef.kind === 'inline' && valueRef.value !== undefined) {
    if (typeof valueRef.value === 'string') {
      const trimmed = valueRef.value.trim();
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          const media = extractMediaItems(parsed);
          if (media) return { text: 'Generated media', mediaItems: media, ...stProp };
          return { text: 'Output', richData: parsed, ...stProp };
        } catch {
          /* not valid JSON, render as text */
        }
      }
      return { text: valueRef.value, ...stProp };
    }
    if (typeof valueRef.value === 'object' && valueRef.value !== null) {
      const obj = valueRef.value as Record<string, unknown>;

      const media = extractMediaItems(obj);
      if (media) return { text: 'Generated media', mediaItems: media, ...stProp };

      for (const key of ['message', 'text', 'content', 'response', 'output', 'result']) {
        const val = obj[key];
        if (typeof val === 'string') return { text: val, ...stProp };
      }
      return { text: 'Output', richData: valueRef.value, ...stProp };
    }
    if (
      typeof valueRef.value === 'number' ||
      typeof valueRef.value === 'boolean' ||
      typeof valueRef.value === 'bigint'
    ) {
      return { text: String(valueRef.value), ...stProp };
    }
    if (typeof valueRef.value === 'symbol') {
      return { text: valueRef.value.toString(), ...stProp };
    }
    return { text: '', ...stProp };
  }

  if (valueRef.kind === 'ref') {
    const ref = valueRef.payloadRef;
    if (valueRef.preview?.text) return { text: valueRef.preview.text, payloadRef: ref, ...stProp };
    if (valueRef.preview?.json) {
      const media = extractMediaItems(valueRef.preview.json);
      if (media) return { text: 'Generated media', mediaItems: media, ...stProp };
      return { text: 'Output', richData: valueRef.preview.json, payloadRef: ref, ...stProp };
    }
    if (ref) return { text: 'Output available', payloadRef: ref, ...stProp };
    return null;
  }

  return null;
}
