/**
 * The author-facing bridge — `window.aflow.act`, `window.aflow.media` and the
 * 'aflowstate' event. Whatever the host does not resolve here, the view has no
 * other way to learn, so a refusal's message has to come back through this hop
 * or it is lost.
 */
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  APPLET_MEDIA_MAX_RESIDENT_BYTES,
  PHOENIX_APPLET_ACTION_MESSAGE_TYPE,
  PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
  PHOENIX_APPLET_STATE_MESSAGE_TYPE,
  type AppletAssetPin,
  type PhoenixAppletActionResultMessage,
} from '@aflow/schemas';
import { AFLOW_HOST_PROTOCOL_JS } from './hostProtocol.js';

interface MediaResult {
  status: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  reason?: string;
  message?: string;
}

interface Bridge {
  act: (
    name: string,
    input: Record<string, unknown>,
    extras?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  media: (asset: AppletAssetPin) => Promise<MediaResult>;
}

interface MountedBridge {
  aflow: Bridge;
  sent: Array<Record<string, unknown>>;
  /** Delivers a message from the embedding host, as the parent frame would. */
  fromHost: (message: Record<string, unknown>) => void;
  /** Delivers a message from anything that is not the parent frame. */
  fromStranger: (message: Record<string, unknown>) => void;
  events: Array<{ type: string; detail: unknown }>;
  /** Object URLs the frame minted, and the ones it gave back. */
  minted: string[];
  revoked: string[];
}

function mountBridge(): MountedBridge {
  const sent: Array<Record<string, unknown>> = [];
  const events: Array<{ type: string; detail: unknown }> = [];
  const listeners: Array<(event: unknown) => void> = [];
  const minted: string[] = [];
  const revoked: string[] = [];
  const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) };
  const window: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'message') listeners.push(listener);
    },
    dispatchEvent: (event: { type: string; detail: unknown }) => events.push(event),
  };
  const context = vm.createContext({
    window,
    parent,
    crypto,
    // The frame's own origin is opaque, so the URL it mints reads `blob:null/…`.
    URL: {
      createObjectURL: () => {
        const url = `blob:null/${String(minted.length + 1)}`;
        minted.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  });
  vm.runInContext(AFLOW_HOST_PROTOCOL_JS, context);

  const deliver = (source: unknown, data: Record<string, unknown>): void => {
    for (const listener of listeners) listener({ source, data });
  };
  return {
    aflow: window['aflow'] as Bridge,
    sent,
    events,
    minted,
    revoked,
    fromHost: (message) => deliver(parent, message),
    fromStranger: (message) => deliver({}, message),
  };
}

function resultFor(sent: Array<Record<string, unknown>>): string {
  return sent.at(-1)!['actionId'] as string;
}

describe('the applet host bridge', () => {
  it('resolves a refusal with the reason the gateway gave', async () => {
    const bridge = mountBridge();
    const pending = bridge.aflow.act('move_clip', { fromIndex: 3 });
    const result: PhoenixAppletActionResultMessage = {
      type: PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
      actionId: resultFor(bridge.sent),
      status: 'rejected',
      reason: 'guard_rejected',
      message: 'No clip sits at fromIndex on that track — read the timeline.',
      availableActions: ['move_clip'],
    };
    bridge.fromHost(result as unknown as Record<string, unknown>);

    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      reason: 'guard_rejected',
      message: 'No clip sits at fromIndex on that track — read the timeline.',
      availableActions: ['move_clip'],
    });
  });

  it('resolves a conflict with the version to recompute against', async () => {
    const bridge = mountBridge();
    const pending = bridge.aflow.act('set_title', { title: 'Cut 2' });
    bridge.fromHost({
      type: PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
      actionId: resultFor(bridge.sent),
      status: 'conflict',
      currentVersion: 12,
    });
    await expect(pending).resolves.toMatchObject({ status: 'conflict', currentVersion: 12 });
  });

  it('stamps the baseVersion from the last state the host pushed', async () => {
    const bridge = mountBridge();
    bridge.fromHost({
      type: PHOENIX_APPLET_STATE_MESSAGE_TYPE,
      state: { title: 'Cut 1' },
      version: 7,
      viewer: { userId: 'u', spaceRole: 'editor', appletRoles: [] },
    });
    expect(bridge.events.at(-1)).toMatchObject({
      type: 'aflowstate',
      detail: { version: 7, state: { title: 'Cut 1' } },
    });

    void bridge.aflow.act('set_title', { title: 'Cut 2' });
    expect(bridge.sent.at(-1)).toMatchObject({
      type: PHOENIX_APPLET_ACTION_MESSAGE_TYPE,
      baseVersion: 7,
    });
  });

  it('turns the bytes the host serves into a url the frame can play', async () => {
    const bridge = mountBridge();
    const asset: AppletAssetPin = {
      path: '/film/shots/sh_a1b2c3d4/take_2.mp4',
      version: 1,
      contentHash: 'f00dcafe1234',
    };
    const pending = bridge.aflow.media(asset);

    const request = bridge.sent.at(-1)!;
    expect(request).toMatchObject({ type: PHOENIX_APPLET_MEDIA_MESSAGE_TYPE, asset });

    bridge.fromHost({
      type: PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
      requestId: request['requestId'],
      status: 'ready',
      blob: new Blob(['clip-bytes']),
      mimeType: 'video/mp4',
      sizeBytes: 10,
    });

    await expect(pending).resolves.toEqual({
      status: 'ready',
      url: 'blob:null/1',
      mimeType: 'video/mp4',
      sizeBytes: 10,
    });
  });

  it('resolves a refusal with the reason the host gave', async () => {
    const bridge = mountBridge();
    const pending = bridge.aflow.media({
      path: '/hr/salaries.csv',
      version: 1,
      contentHash: 'deadbeef9999',
    });
    bridge.fromHost({
      type: PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
      requestId: bridge.sent.at(-1)!['requestId'],
      status: 'refused',
      reason: 'not_referenced',
      message: 'Nothing this board holds points at /hr/salaries.csv version 1.',
    });

    await expect(pending).resolves.toEqual({
      status: 'refused',
      reason: 'not_referenced',
      message: 'Nothing this board holds points at /hr/salaries.csv version 1.',
    });
    expect(bridge.minted).toEqual([]);
  });

  it('asks the host once however many times the view shows the same asset', async () => {
    const bridge = mountBridge();
    const asset: AppletAssetPin = {
      path: '/film/frames/opening.png',
      version: 3,
      contentHash: 'beadfeed5678',
    };
    const first = bridge.aflow.media(asset);
    const second = bridge.aflow.media(asset);
    expect(bridge.sent).toHaveLength(1);

    bridge.fromHost({
      type: PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
      requestId: bridge.sent.at(-1)!['requestId'],
      status: 'ready',
      blob: new Blob(['frame']),
      mimeType: 'image/png',
      sizeBytes: 5,
    });
    expect(await first).toEqual(await second);

    await expect(bridge.aflow.media(asset)).resolves.toMatchObject({ url: 'blob:null/1' });
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.minted).toEqual(['blob:null/1']);
  });

  it('gives back the least recently shown asset once it holds a budget of them', async () => {
    const bridge = mountBridge();
    const third = Math.ceil(APPLET_MEDIA_MAX_RESIDENT_BYTES / 3) + 1;
    const assetFor = (index: number): AppletAssetPin => ({
      path: `/film/shots/sh_a1b2c3d${String(index)}/take_1.mp4`,
      version: 1,
      contentHash: `f00dcafe123${String(index)}`,
    });

    for (const index of [1, 2, 3]) {
      const pending = bridge.aflow.media(assetFor(index));
      bridge.fromHost({
        type: PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
        requestId: bridge.sent.at(-1)!['requestId'],
        status: 'ready',
        blob: new Blob(['clip']),
        mimeType: 'video/mp4',
        sizeBytes: third,
      });
      await pending;
    }

    expect(bridge.revoked).toEqual(['blob:null/1']);
    expect(bridge.sent.at(-1)).toEqual({
      type: PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE,
      asset: assetFor(1),
    });
  });

  it('ignores a frame that is not the embedding host', () => {
    const bridge = mountBridge();
    bridge.fromStranger({
      type: PHOENIX_APPLET_STATE_MESSAGE_TYPE,
      state: { title: 'forged' },
      version: 99,
      viewer: { userId: 'u', spaceRole: 'editor', appletRoles: [] },
    });
    expect(bridge.events).toEqual([]);
  });
});
