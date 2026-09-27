/**
 * The film applet driven through the real write gateway. Every case here is a
 * state a film cannot be in — a clip that plays a shot nobody declared, an
 * orphan sidecar, conditioning that names a role the shot never bound, a take
 * recorded against a shot that has since moved — asserted where it is actually
 * decided, because an action's input schema only binds when the platform is
 * the one materializing the patch.
 */
import { describe, expect, it } from 'vitest';
import type { AppletStatePatchOp } from '@aflow/schemas';
import { apply, makeStore, refusal, type Store } from './filmStore.js';

// ============================================================================
// Fixtures
// ============================================================================

const PIN = { path: '/film/lead.json', version: 1, contentHash: 'abcd1234' };

function timeRange(start: number, duration: number) {
  return {
    startTime: { value: start, rate: 24 },
    duration: { value: duration, rate: 24 },
  };
}

const GRADE_PLATE = { path: '/film/grade.png', version: 1, contentHash: 'gradeplate01' };
const KEYFRAME_RECIPE = {
  framing: 'wide, camera at the far end of the kitchen',
  prompt: 'a kitchen at dawn, nobody in it yet',
  route: 'google-pro-image',
  gradePlate: GRADE_PLATE,
};

const RECIPE = {
  prompt: 'a kitchen at dawn',
  negativePrompt: '',
  screenDirection: 'none',
  durationSeconds: 4,
  route: { model: 'runware-kling', quality: 'draft' },
  conditioning: { mode: 'prompt' },
  keyframe: null,
  entities: {},
};
const NO_KEYFRAME = { asset: null, renderedFrom: null };

function shot(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Kitchen wide',
    ...RECIPE,
    sceneId: null,
    durationSeconds: 4,
    speed: 1,
    keyframeRecipe: null,
    keyframe: NO_KEYFRAME,
    selectedTake: null,
    takes: null,
    note: '',
    ...overrides,
  };
}

function take(takeId: string) {
  return { takeId, asset: PIN, note: '', renderedFrom: RECIPE };
}

function clip(shotId: string) {
  return { kind: 'clip', shotId, sourceRange: timeRange(0, 96) };
}

function videoItems(store: Store): Array<Record<string, unknown>> {
  const timeline = store.state['timeline'] as { tracks: Array<{ items: unknown[] }> };
  return timeline.tracks[0]!.items as Array<Record<string, unknown>>;
}

async function seedTwoShots(store: Store) {
  await apply(store, 'add_shot', { shot: shot({ name: 'One' }), clip: clip('sh_aaaaaaaa') });
  await apply(store, 'add_shot', { shot: shot({ name: 'Two' }), clip: clip('sh_bbbbbbbb') });
}

// ============================================================================
// The state cannot express a film that is not true
// ============================================================================

describe('film — a timeline edit cannot carry its own patch', () => {
  for (const name of ['reorder_shot', 'remove_shot', 'trim_clip']) {
    it(`'${name}' refuses an actor-supplied patch, so its input schema is not decoration`, async () => {
      const store = makeStore();
      await seedTwoShots(store);

      const forged: AppletStatePatchOp[] = [
        { op: 'remove', path: '/state/timeline/tracks/0/items/1' },
      ];
      const refused = await refusal(
        store,
        name,
        name === 'reorder_shot'
          ? { trackIndex: 0, fromIndex: 1, toIndex: 0, clip: clip('sh_bbbbbbbb') }
          : name === 'remove_shot'
            ? { shotId: 'sh_bbbbbbbb', trackIndex: 0, itemIndex: 1 }
            : {
                trackIndex: 0,
                itemIndex: 0,
                shotId: 'sh_aaaaaaaa',
                sourceRange: timeRange(0, 24),
              },
        forged,
      );
      expect(refused.reason).toBe('invalid_patch');
      expect(refused.message).toMatch(/the platform materializes its patch/);
      expect(videoItems(store)).toHaveLength(2);
    });
  }
});

describe('film — a clip cannot name a shot that does not exist', () => {
  it('add_timeline_item has no shape for a clip', async () => {
    const store = makeStore();
    const refused = await refusal(store, 'add_timeline_item', {
      trackIndex: 0,
      item: clip('sh_doesnotexist'),
    });
    expect(refused.reason).toBe('invalid_input');
    expect(videoItems(store)).toHaveLength(0);
  });

  it('a shot and its clip leave together or not at all', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    await apply(store, 'remove_shot', { shotId: 'sh_aaaaaaaa', trackIndex: 0, itemIndex: 0 });
    expect(Object.keys(store.state['shots'] as object)).toEqual(['sh_bbbbbbbb']);
    expect(Object.keys(store.state['shotAssets'] as object)).toEqual(['sh_bbbbbbbb']);
    expect(videoItems(store).map((item) => item['shotId'])).toEqual(['sh_bbbbbbbb']);
  });

  it('removing a shot at an index that plays a different shot is refused', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    const refused = await refusal(store, 'remove_shot', {
      shotId: 'sh_aaaaaaaa',
      trackIndex: 0,
      itemIndex: 1,
    });
    expect(refused.reason).toBe('invalid_patch');
    expect(Object.keys(store.state['shots'] as object)).toHaveLength(2);
    expect(videoItems(store)).toHaveLength(2);
  });

  it('a reorder cannot substitute a clip for one that plays nothing', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    const refused = await refusal(store, 'reorder_shot', {
      trackIndex: 0,
      fromIndex: 1,
      toIndex: 0,
      clip: clip('sh_doesnotexist'),
    });
    expect(refused.reason).toBe('invalid_patch');
    expect(videoItems(store).map((item) => item['shotId'])).toEqual(['sh_aaaaaaaa', 'sh_bbbbbbbb']);
  });

  it('a move past the end of the track leaves the track as it was', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    const refused = await refusal(store, 'reorder_shot', {
      trackIndex: 0,
      fromIndex: 0,
      toIndex: 9,
      clip: clip('sh_aaaaaaaa'),
    });
    expect(refused.reason).toBe('invalid_patch');
    expect(videoItems(store).map((item) => item['shotId'])).toEqual(['sh_aaaaaaaa', 'sh_bbbbbbbb']);
  });

  it('an item on a track a shot never reached is removed by kind, and a clip is not', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    const gap = { kind: 'gap', duration: { value: 24, rate: 24 } };
    await apply(store, 'add_timeline_item', { trackIndex: 1, item: gap });
    await apply(store, 'remove_timeline_item', { trackIndex: 1, itemIndex: 0, kind: 'gap' });

    const refused = await refusal(store, 'remove_timeline_item', {
      trackIndex: 0,
      itemIndex: 0,
      kind: 'audio',
    });
    expect(refused.reason).toBe('invalid_patch');
    expect(videoItems(store)).toHaveLength(2);
  });
});

describe('film — a shot that holds a character', () => {
  it('conditions on its bindings while animating a starting frame', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    // The wired way to keep a character recognisable across shots: the route
    // reads the bound entities only while animating a frame, so a shot that
    // could not carry both had no way to ask for it.
    await apply(store, 'set_recipe', {
      shotId: 'sh_aaaaaaaa',
      route: { model: 'runware-kling', quality: 'final' },
      conditioning: { mode: 'reference', endFrame: null },
      keyframeRecipe: KEYFRAME_RECIPE,
    });
    await apply(store, 'bind_shot_entity', {
      shotId: 'sh_aaaaaaaa',
      role: 'lead',
      entity: { kind: 'character', name: 'Mara', pins: [PIN] },
    });

    const shots = store.state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots['sh_aaaaaaaa']!['conditioning']).toEqual({ mode: 'reference', endFrame: null });
    expect(shots['sh_aaaaaaaa']!['keyframeRecipe']).toEqual(KEYFRAME_RECIPE);
    // The name is what the prompt has to say for the route to read it.
    expect(shots['sh_aaaaaaaa']!['entities']).toEqual({
      lead: { kind: 'character', name: 'Mara', pins: [PIN] },
    });
  });

  it('holds several angles of one identity', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    const profile = { ...PIN, version: 2 };
    await apply(store, 'bind_entity', {
      entityKey: 'mara',
      entity: { kind: 'character', name: 'Mara', pins: [PIN, profile] },
    });
    const entities = store.state['entities'] as Record<string, Record<string, unknown>>;
    // One image is a weaker likeness than several, and the route reads them as
    // one identity rather than as two characters.
    expect(entities['mara']!['pins']).toEqual([PIN, profile]);
  });

  it('a shot animating a frame it has no recipe for reads as owing one, and cannot be dispatched', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    // The state is authorable — the recipe and the mode are separate members
    // now, so nothing in the schema can tie them. What stops the spend is that
    // the shot has no frame: `ai.media.animate` requires one, and the only
    // route left carries no references at all.
    await apply(store, 'set_recipe', {
      shotId: 'sh_aaaaaaaa',
      route: { model: 'runware-kling', quality: 'final' },
      conditioning: { mode: 'reference', endFrame: null },
      keyframeRecipe: null,
    });
    const shots = store.state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots['sh_aaaaaaaa']!['keyframeRecipe']).toBeNull();
    expect(shots['sh_aaaaaaaa']!['keyframe']).toEqual({ asset: null, renderedFrom: null });
  });
});

describe('film — the world is named before the shot that uses it', () => {
  const REFERENCE = { mode: 'reference', endFrame: null };

  const setRecipe = (keyframeRecipe: unknown) => ({
    shotId: 'sh_aaaaaaaa',
    route: { model: 'runware-kling', quality: 'final' },
    conditioning: REFERENCE,
    keyframeRecipe,
  });

  it('refuses a keyframe that states no camera', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    // A keyframe with a set plate and no camera reproduces the plate's own
    // framing, so every shot of one place comes back the same picture.
    const { framing: _dropped, ...cameraless } = KEYFRAME_RECIPE;
    const refused = await refusal(store, 'set_recipe', setRecipe(cameraless));
    expect(refused.reason).toBe('invalid_input');
  });

  it('refuses a keyframe authored against no grade, so the look cannot come out of the shots', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    const refused = await refusal(
      store,
      'set_recipe',
      setRecipe({ ...KEYFRAME_RECIPE, gradePlate: null }),
    );
    expect(refused.reason).toBe('invalid_input');
  });

  it('refuses a keyframe route that reads no reference at all', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    // A route that reads none of the film's plates returns a still holding
    // nothing of the world, and nothing downstream can tell the difference.
    const refused = await refusal(
      store,
      'set_recipe',
      setRecipe({ ...KEYFRAME_RECIPE, route: 'google-flash-image' }),
    );
    expect(refused.reason).toBe('invalid_input');
  });

  it('a recorded keyframe says what it answered, and restales the takes it replaces', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    await apply(store, 'set_recipe', setRecipe(KEYFRAME_RECIPE));

    const keyframe = {
      asset: { path: '/film/frames/one.png', version: 1, contentHash: 'stillone01' },
      renderedFrom: { recipe: KEYFRAME_RECIPE, entities: {}, screenDirection: 'none' },
    };
    await apply(store, 'record_keyframe', { shotId: 'sh_aaaaaaaa', keyframe });
    const shots = store.state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots['sh_aaaaaaaa']!['keyframe']).toEqual(keyframe);

    // A take that animated the frame this one replaced no longer matches.
    const stale = await refusal(store, 'select_take', {
      shotId: 'sh_aaaaaaaa',
      take: {
        takeId: 't1',
        asset: PIN,
        note: '',
        renderedFrom: {
          ...RECIPE,
          route: { model: 'runware-kling', quality: 'final' },
          conditioning: REFERENCE,
          keyframe: null,
        },
      },
    });
    expect(stale.reason).toBe('invalid_patch');
  });

  it('a frame answering a recipe the shot edited past is recorded, and reads as owing a re-render', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    await apply(store, 'set_recipe', setRecipe(KEYFRAME_RECIPE));
    const moved = { ...KEYFRAME_RECIPE, framing: 'tight on the door, camera at knee height' };
    await apply(store, 'set_recipe', setRecipe(moved));

    // The record is a fact about a render that happened, so it lands rather
    // than being refused — and it says which recipe it answered, which is what
    // makes the shot read as owing a new one.
    const keyframe = {
      asset: { path: '/film/frames/one.png', version: 1, contentHash: 'stillone01' },
      renderedFrom: { recipe: KEYFRAME_RECIPE, entities: {}, screenDirection: 'none' },
    };
    await apply(store, 'record_keyframe', { shotId: 'sh_aaaaaaaa', keyframe });
    const shots = store.state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots['sh_aaaaaaaa']!['keyframe']).toEqual(keyframe);
    expect(shots['sh_aaaaaaaa']!['keyframeRecipe']).toEqual(moved);
  });

  it('a keyframe records the bindings its render read, so a repin is visible on the frame', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    const mara = { kind: 'character', name: 'Mara', pins: [PIN] };
    await apply(store, 'set_recipe', setRecipe(KEYFRAME_RECIPE));
    await apply(store, 'bind_shot_entity', { shotId: 'sh_aaaaaaaa', role: 'lead', entity: mara });
    await apply(store, 'record_keyframe', {
      shotId: 'sh_aaaaaaaa',
      keyframe: {
        asset: { path: '/film/frames/one.png', version: 1, contentHash: 'stillone01' },
        renderedFrom: {
          recipe: KEYFRAME_RECIPE,
          entities: { lead: mara },
          screenDirection: 'none',
        },
      },
    });
    // The still shows the version it was rendered with, and the still itself
    // carries no likeness anyone can compare — so the bindings are the record.
    await apply(store, 'bind_shot_entity', {
      shotId: 'sh_aaaaaaaa',
      role: 'lead',
      entity: { ...mara, pins: [{ ...PIN, version: 2 }] },
    });
    const shots = store.state['shots'] as Record<string, Record<string, unknown>>;
    const recorded = shots['sh_aaaaaaaa']!['keyframe'] as {
      renderedFrom: { entities: Record<string, unknown> };
    };
    expect(recorded.renderedFrom.entities).toEqual({ lead: mara });
    expect(recorded.renderedFrom.entities).not.toEqual(shots['sh_aaaaaaaa']!['entities']);
  });
});

describe('film — a recorded keyframe cannot be un-recorded by the action that records it', () => {
  it('refuses the empty keyframe, so a paid frame does not leave through record_keyframe', async () => {
    const store = makeStore();
    await seedTwoShots(store);
    await apply(store, 'set_recipe', {
      shotId: 'sh_aaaaaaaa',
      route: { model: 'runware-kling', quality: 'final' },
      conditioning: { mode: 'reference', endFrame: null },
      keyframeRecipe: KEYFRAME_RECIPE,
    });
    const keyframe = {
      asset: { path: '/film/frames/one.png', version: 1, contentHash: 'stillone01' },
      renderedFrom: { recipe: KEYFRAME_RECIPE, entities: {}, screenDirection: 'none' },
    };
    await apply(store, 'record_keyframe', { shotId: 'sh_aaaaaaaa', keyframe });

    // The state member is nullable so a shot can be born without a frame; the
    // action that records one must not be how a frame and its provenance go.
    const refused = await refusal(store, 'record_keyframe', {
      shotId: 'sh_aaaaaaaa',
      keyframe: NO_KEYFRAME,
    });
    expect(refused.reason).toBe('invalid_input');
    const shots = store.state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots['sh_aaaaaaaa']!['keyframe']).toEqual(keyframe);
  });
});
