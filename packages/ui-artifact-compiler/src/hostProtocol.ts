/**
 * Host↔iframe protocol snippets injected into every artifact shell.
 * The author-facing surface is only `window.aflow.act`, `window.aflow.media`
 * and the 'aflowstate' CustomEvent; the postMessage wire format stays
 * host-internal.
 */
import {
  APPLET_MEDIA_MAX_RESIDENT_BYTES,
  PHOENIX_APPLET_ACTION_MESSAGE_TYPE,
  PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
  PHOENIX_APPLET_STATE_MESSAGE_TYPE,
} from '@aflow/schemas';

/**
 * Author-facing host action protocol, injected into every artifact shell.
 * Authors see only \`window.aflow.act(name, input, extras?)\`,
 * \`window.aflow.media(asset)\` and the 'aflowstate' CustomEvent — the
 * postMessage wire format stays host-internal.
 */
export const AFLOW_HOST_PROTOCOL_JS = `
// window.aflow.act(name, input, extras?) -> Promise of { status, ... };
// window.aflow.media(asset) -> Promise of { status: 'ready', url } | { status: 'refused', reason, message };
// live state arrives as the 'aflowstate' CustomEvent.
(() => {
  const pending = new Map();
  const mediaHeld = new Map();
  const mediaInFlight = new Map();
  const mediaPending = new Map();
  let mediaResidentBytes = 0;
  let mediaClock = 0;
  let lastVersion = 0;

  const mediaKey = (asset) =>
    asset && typeof asset === 'object'
      ? asset.path + '@' + asset.version + '#' + asset.contentHash
      : String(asset);

  // The host holds the bytes for everything it has granted, so a view that
  // shows a whole timeline would pin it all. Dropping the least recently
  // asked-for keeps that bounded without the author tracking lifetimes.
  const evictMedia = () => {
    while (mediaResidentBytes > ${String(APPLET_MEDIA_MAX_RESIDENT_BYTES)} && mediaHeld.size > 1) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, entry] of mediaHeld) {
        if (entry.usedAt < oldest) { oldest = entry.usedAt; oldestKey = key; }
      }
      if (oldestKey === null) return;
      const entry = mediaHeld.get(oldestKey);
      mediaHeld.delete(oldestKey);
      mediaResidentBytes -= entry.sizeBytes;
      URL.revokeObjectURL(entry.url);
      window.parent.postMessage({
        type: '${PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE}',
        asset: entry.asset,
      }, '*');
    }
  };

  window.aflow = {
    media(asset) {
      const key = mediaKey(asset);
      const held = mediaHeld.get(key);
      if (held) {
        held.usedAt = ++mediaClock;
        return Promise.resolve({
          status: 'ready',
          url: held.url,
          mimeType: held.mimeType,
          sizeBytes: held.sizeBytes,
        });
      }
      const inFlight = mediaInFlight.get(key);
      if (inFlight) return inFlight;
      const requestId = crypto.randomUUID();
      const promise = new Promise((resolve) => {
        mediaPending.set(requestId, { resolve, key, asset });
        window.parent.postMessage({
          type: '${PHOENIX_APPLET_MEDIA_MESSAGE_TYPE}',
          requestId,
          asset,
        }, '*');
      });
      mediaInFlight.set(key, promise);
      return promise;
    },
    act(name, input, extras) {
      const message = {
        type: '${PHOENIX_APPLET_ACTION_MESSAGE_TYPE}',
        actionId: crypto.randomUUID(),
        baseVersion: lastVersion,
        name,
        input: input || {},
      };
      if (extras && extras.patch) message.proposedPatch = extras.patch;
      if (extras && extras.outcome != null) message.outcome = extras.outcome;
      if (extras && extras.silent) message.silent = true;
      return new Promise((resolve) => {
        pending.set(message.actionId, resolve);
        window.parent.postMessage(message, '*');
      });
    },
  };
  window.addEventListener('message', (event) => {
    // Only the embedding host may speak: a sibling artifact iframe can reach
    // this window via window.parent.frames[i] and would otherwise be able to
    // forge state or fake applied results.
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === '${PHOENIX_APPLET_STATE_MESSAGE_TYPE}') {
      lastVersion = msg.version;
      window.dispatchEvent(new CustomEvent('aflowstate', {
        detail: { state: msg.state, version: msg.version, viewer: msg.viewer, seats: msg.seats },
      }));
    } else if (msg.type === '${PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE}') {
      const request = mediaPending.get(msg.requestId);
      if (!request) return;
      mediaPending.delete(msg.requestId);
      mediaInFlight.delete(request.key);
      if (msg.status !== 'ready' || !msg.blob) {
        request.resolve({ status: 'refused', reason: msg.reason, message: msg.message });
        return;
      }
      // The host's own object URL belongs to the embedding origin, which this
      // frame cannot address — the Blob crosses and the URL is minted here.
      const url = URL.createObjectURL(msg.blob);
      const sizeBytes = msg.sizeBytes || msg.blob.size;
      mediaHeld.set(request.key, {
        url,
        mimeType: msg.mimeType,
        sizeBytes,
        asset: request.asset,
        usedAt: ++mediaClock,
      });
      mediaResidentBytes += sizeBytes;
      evictMedia();
      request.resolve({ status: 'ready', url, mimeType: msg.mimeType, sizeBytes });
    } else if (msg.type === '${PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE}') {
      const resolve = pending.get(msg.actionId);
      if (!resolve) return;
      pending.delete(msg.actionId);
      resolve({
        status: msg.status,
        receipt: msg.receipt,
        currentVersion: msg.currentVersion,
        message: msg.message,
        reason: msg.reason,
        validation: msg.validation,
        availableActions: msg.availableActions,
      });
    }
  });
})();
`;

/**
 * JS snippet that listens for phoenix:theme messages and sets the data-theme attribute.
 */
export const THEME_LISTENER_JS = `
// Theme passthrough — host app sends resolved theme via PostMessage
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  if (event.data && event.data.type === 'phoenix:theme') {
    document.documentElement.setAttribute('data-theme', event.data.theme || 'light');
  }
});
`;
