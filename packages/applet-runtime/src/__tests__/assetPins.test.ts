/**
 * The permitted set for the media channel. What a state pins is servable;
 * everything else in the space is not, however the request is written.
 */
import { describe, expect, it } from 'vitest';
import { appletAssetPinKey, type AppletAssetPin } from '@aflow/schemas';
import { appletStateReferencesAsset, collectAppletAssetPins } from '../assetPins.js';

const TAKE: AppletAssetPin = {
  path: '/film/shots/sh_a1b2c3d4/take_2.mp4',
  version: 1,
  contentHash: 'f00dcafe1234',
};

const FRAME: AppletAssetPin = {
  path: '/film/frames/opening.png',
  version: 3,
  contentHash: 'beadfeed5678',
};

const filmState = (): Record<string, unknown> => ({
  title: 'Cut 2',
  shots: {
    sh_a1b2c3d4: {
      name: 'Opening',
      conditioning: { mode: 'frames', endFrame: null },
      keyframe: { asset: FRAME, renderedFrom: null },
      selectedTake: { takeId: 't2', asset: TAKE, note: '' },
    },
  },
  tracks: [{ clips: [{ kind: 'clip', shotId: 'sh_a1b2c3d4' }] }],
});

describe('the assets an applet state pins', () => {
  it('finds every pin however deep or dynamically keyed', () => {
    const pins = collectAppletAssetPins(filmState());
    expect([...pins.keys()].sort()).toEqual(
      [appletAssetPinKey(TAKE), appletAssetPinKey(FRAME)].sort(),
    );
  });

  it('permits an asset the state pins', () => {
    expect(appletStateReferencesAsset(filmState(), TAKE)).toBe(true);
  });

  it('refuses a document the state never names', () => {
    const salaries: AppletAssetPin = {
      path: '/hr/salaries.csv',
      version: 1,
      contentHash: 'deadbeef9999',
    };
    expect(appletStateReferencesAsset(filmState(), salaries)).toBe(false);
  });

  it('refuses another version of a path the state pins', () => {
    expect(appletStateReferencesAsset(filmState(), { ...TAKE, version: 2 })).toBe(false);
    expect(appletStateReferencesAsset(filmState(), { ...TAKE, contentHash: '0000111122' })).toBe(
      false,
    );
  });

  it('reads no pin out of a reference that names only a path', () => {
    const state = { note: { path: '/film/shots/sh_a1b2c3d4/take_2.mp4' } };
    expect(collectAppletAssetPins(state).size).toBe(0);
  });

  it('stops at the state depth bound rather than following a cycle', () => {
    const state: Record<string, unknown> = { pin: TAKE };
    state['self'] = state;
    expect(appletStateReferencesAsset(state, TAKE)).toBe(true);
  });
});
