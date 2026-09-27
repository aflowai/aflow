/**
 * The film view — the surface the room watches the cut on.
 *
 * Three things are asserted, and they are different: that the view compiles
 * against the catalog it is pinned to, that the room sees frames rather than
 * reads a script, and that what it sends is what the platform accepts. The
 * last is not taken on trust — every command the view emits is replayed
 * through the real write gateway against the same film the view was looking
 * at, so an input the schema would refuse fails here.
 *
 * Where a shot stands is read off the document, so the states that matter are
 * rendered rather than described: an empty film, a shot with no take, a take
 * gone stale, a clip the host will not serve, and a viewer who may only watch.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateAndCompile } from '@aflow/ui-artifact-compiler';
import { FILM_CATALOG_PIN, FILM_DEFINITION, FILM_VIEW_SOURCE } from '../appletFixtures/film.js';
import { apply, makeStore, type Store } from './filmStore.js';
import { mountFilmView, type ActCall, type MountedView } from './filmViewHarness.js';

// ============================================================================
// The film the room is looking at
// ============================================================================

const PIN = { path: '/film/mara.json', version: 1, contentHash: 'abcd1234' };
const MARA = { kind: 'character', name: 'Mara', pins: [PIN] };
const SCORE = { path: '/film/score.wav', version: 1, contentHash: 'beefcafe' };
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

function shot(name: string) {
  return {
    name,
    ...RECIPE,
    sceneId: null,
    durationSeconds: 4,
    speed: 1,
    keyframeRecipe: null,
    keyframe: NO_KEYFRAME,
    selectedTake: null,
    takes: null,
    note: '',
  };
}

/** Every take is its own file, because the strip is keyed by the asset it plays. */
function clipAsset(takeId: string) {
  return { path: `/film/takes/${takeId}.mp4`, version: 1, contentHash: `hash${takeId}0000` };
}

function take(takeId: string, overrides: Record<string, unknown> = {}) {
  return {
    takeId,
    asset: clipAsset(takeId),
    note: '',
    renderedFrom: RECIPE,
    ...overrides,
  };
}

function clip(shotId: string) {
  return {
    kind: 'clip',
    shotId,
    sourceRange: { startTime: { value: 0, rate: 24 }, duration: { value: 96, rate: 24 } },
  };
}

const SETTLED = 'sh_aaaaaaaa';
const STALE = 'sh_bbbbbbbb';
const WAITING = 'sh_cccccccc';

/**
 * One film carrying every reading the view has to make: a settled shot, a take
 * gone stale on an axis the view can rewrite, a shot still waiting on a
 * generation, a bound role, and an open note.
 */
async function seedFilm(): Promise<Store> {
  const store = makeStore();
  await apply(store, 'set_project', {
    title: 'Nightshift',
    logline: 'A baker works the small hours.',
    aspectRatio: '16:9',
    fps: 24,
  });
  await apply(store, 'set_grade', { grade: { look: 'cool sodium night', note: '', plate: null } });
  await apply(store, 'bind_entity', { entityKey: 'mara', entity: MARA });

  await apply(store, 'add_shot', { shot: shot('Kitchen wide'), clip: clip(SETTLED) });
  await apply(store, 'add_shot', { shot: shot('Hands on dough'), clip: clip(STALE) });
  await apply(store, 'add_shot', { shot: shot('Door opens'), clip: clip(WAITING) });

  await apply(store, 'select_take', { shotId: SETTLED, take: take('t1') });

  await apply(store, 'select_take', { shotId: STALE, take: take('t2') });
  await apply(store, 'set_prompt', {
    shotId: STALE,
    prompt: 'hands folding dough at dusk',
    negativePrompt: '',
    screenDirection: 'none',
  });

  await apply(store, 'bind_shot_entity', { shotId: WAITING, role: 'lead', entity: MARA });
  await apply(store, 'add_marker', {
    markerId: 'mk_note01',
    marker: { shotId: SETTLED, at: { value: 12, rate: 24 }, comment: 'the sodium reads too green' },
  });
  return store;
}

/** A cut long enough that pulling every clip at once would be the wrong answer. */
async function seedLongFilm(count: number): Promise<Store> {
  const store = makeStore();
  for (let index = 0; index < count; index += 1) {
    const shotId = `sh_${String(index).padStart(8, '0')}`;
    await apply(store, 'add_shot', { shot: shot(`Shot ${index + 1}`), clip: clip(shotId) });
    await apply(store, 'select_take', { shotId, take: take(`t${index}`) });
  }
  return store;
}

/**
 * A film of two shots with a hold between them — the case where the position
 * the room sees and the position on the track are different numbers.
 */
async function seedWithHold(): Promise<Store> {
  const store = makeStore();
  await apply(store, 'add_shot', { shot: shot('Kitchen wide'), clip: clip(SETTLED) });
  await apply(store, 'add_timeline_item', {
    trackIndex: 0,
    item: { kind: 'gap', duration: { value: 48, rate: 24 } },
  });
  await apply(store, 'add_shot', { shot: shot('Hands on dough'), clip: clip(STALE) });
  return store;
}

/** One shot whose take is stale on a prompt and on two role bindings at once. */
async function seedMultiAxisStale(): Promise<Store> {
  const store = makeStore();
  await apply(store, 'add_shot', { shot: shot('Kitchen wide'), clip: clip(SETTLED) });
  await apply(store, 'bind_shot_entity', { shotId: SETTLED, role: 'extra', entity: MARA });
  await apply(store, 'select_take', {
    shotId: SETTLED,
    take: take('t1', { renderedFrom: { ...RECIPE, entities: { extra: MARA } } }),
  });
  await apply(store, 'set_prompt', {
    shotId: SETTLED,
    prompt: 'a kitchen at midnight',
    negativePrompt: '',
    screenDirection: 'none',
  });
  await apply(store, 'unbind_shot_entity', { shotId: SETTLED, role: 'extra' });
  await apply(store, 'bind_shot_entity', { shotId: SETTLED, role: 'lead', entity: MARA });
  return store;
}

/** The main video track as the room would read it back, kind by kind. */
function videoTrack(store: Store): string[] {
  const timeline = store.state['timeline'] as {
    tracks: Array<{ items: Array<Record<string, unknown>> }>;
  };
  const items = timeline.tracks[0]?.items ?? [];
  return items.map((item) =>
    item['kind'] === 'clip' ? `clip ${String(item['shotId'])}` : String(item['kind']),
  );
}

const EDITOR = { userId: randomUUID(), spaceRole: 'editor', appletRoles: ['editor'] };

async function openFilm(
  viewer: Record<string, unknown> = EDITOR,
): Promise<{ view: MountedView; store: Store }> {
  const store = await seedFilm();
  const view = await mountFilmView({ state: store.state, viewer, seats: [] });
  await view.settle();
  return { view, store };
}

/**
 * Drives the view, then replays what it sent through the write gateway against
 * the same film — in order, because a restore only settles a take once the
 * steps before it have landed.
 */
async function drive(steps: (view: MountedView) => void): Promise<ActCall[]> {
  const { view } = await openFilm();
  steps(view);
  await view.settle();
  expect(view.calls.length).toBeGreaterThan(0);
  const replay = await seedFilm();
  for (const call of view.calls) {
    await apply(replay, call.name, call.input);
  }
  return view.calls;
}

// ============================================================================
// The view compiles against the catalog it is pinned to
// ============================================================================

describe('film view — the compile gate', () => {
  it('compiles against the pinned design-system catalog with no unknown components', async () => {
    const require = createRequire(import.meta.url);
    const contract = JSON.parse(
      readFileSync(require.resolve('@aflow/design-system/contract-compact.json'), 'utf8'),
    ) as { catalogVersion: string; components: Array<{ name: string }> };

    expect(FILM_CATALOG_PIN.catalogVersion).toBe(contract.catalogVersion);

    const result = await validateAndCompile(
      FILM_VIEW_SOURCE,
      'react_tsx',
      [],
      contract.components.map((component) => component.name),
    );
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error' || diagnostic.code === 'UNKNOWN_COMPONENT',
      ),
    ).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('reaches the host through the declared bridge and nothing else', () => {
    expect(FILM_VIEW_SOURCE).toContain('window.aflow');
    expect(FILM_VIEW_SOURCE).not.toMatch(/XMLHttpRequest|EventSource|WebSocket/);
    // The frame can fetch nothing, so what binds is not which tag loads bytes
    // but where its src came from: every one is a URL the host served over the
    // media bridge. A nested browsing context is a different thing entirely and
    // stays out; so do the elements nothing here needs.
    expect(FILM_VIEW_SOURCE).not.toMatch(/<(iframe|source|audio)\b/);
    const sources = [...FILM_VIEW_SOURCE.matchAll(/\ssrc=\{([^}]+)\}/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(0);
    expect([...new Set(sources)].sort()).toEqual(['frame.url', 'held.url', 'shown.url']);
  });
});

// ============================================================================
// Every action the view names is one the film declares
// ============================================================================

describe('film view — the action surface', () => {
  const declared = new Set(FILM_DEFINITION.actions.map((action) => action.name));

  function namedInSource(): string[] {
    const names = new Set<string>();
    for (const match of FILM_VIEW_SOURCE.matchAll(/(?:send|act)\(\s*'([a-z_]+)'/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
    for (const match of FILM_VIEW_SOURCE.matchAll(/name:\s*'([a-z_]+)'/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
    return [...names].sort();
  }

  it('names only declared actions — the view cannot invent one', () => {
    const named = namedInSource();
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !declared.has(name))).toEqual([]);
  });

  it('leaves the rest to the agent, and says which those are', () => {
    const reachable = new Set(namedInSource());
    expect([...declared].filter((name) => !reachable.has(name)).sort()).toEqual([
      'add_scene',
      'add_shot',
      'add_timeline_item',
      'attach_shot_documents',
      'bind_entity',
      'draft_casting',
      'record_keyframe',
      'remove_timeline_item',
      'set_project',
      'set_recipe',
      'set_route',
      'set_scene',
      'strike_casting',
    ]);
  });

  it('carries no second chat — a sentence to the agent is typed in the chat', () => {
    expect([...declared].filter((name) => name.includes('ask'))).toEqual([]);
    expect(FILM_VIEW_SOURCE).not.toContain('Ask the agent');
  });
});

// ============================================================================
// Frames, not a script
// ============================================================================

describe('film view — the room watches the cut', () => {
  it('an empty film says what it is waiting for rather than looking broken', async () => {
    const view = await mountFilmView({
      state: structuredClone(FILM_DEFINITION.initialState),
      viewer: EDITOR,
      seats: [],
    });
    const text = view.text();
    expect(text).toContain('Untitled film');
    expect(text).toContain('No shots yet');
    expect(text).toContain('no shots yet');
    expect(view.playing()).toEqual([]);
    expect(view.asked).toEqual([]);
  });

  it('plays the shot in hand, and shows the whole cut as a strip in timeline order', async () => {
    const { view } = await openFilm();
    expect(view.screen()).toBe('blob:/film/takes/t1.mp4');
    // The strip carries its own frames, so the next shot is identified by one.
    expect(view.playing()).toContain('blob:/film/takes/t2.mp4');

    const text = view.text();
    const at = (fragment: string) => text.indexOf(fragment);
    expect(at('1. Kitchen wide')).toBeGreaterThan(-1);
    expect(at('1. Kitchen wide')).toBeLessThan(at('2. Hands on dough'));
    expect(at('2. Hands on dough')).toBeLessThan(at('3. Door opens'));
    expect(text).toContain('Nightshift');
    expect(text).toContain('cool sodium night');
  });

  it('a shot with no take says it is waiting, and for what', async () => {
    const { view } = await openFilm();
    view.click('Door opens');
    await view.settle();
    expect(view.text()).toContain('Door opens is waiting on its first take.');
    expect(view.screen()).toBeNull();

    const unbound = makeStore();
    await apply(unbound, 'add_shot', { shot: shot('Kitchen wide'), clip: clip(SETTLED) });
    await apply(unbound, 'set_recipe', {
      shotId: SETTLED,
      route: { model: 'runware-kling', quality: 'draft' },
      conditioning: { mode: 'reference', endFrame: null },
      keyframeRecipe: KEYFRAME_RECIPE,
    });
    const blocked = await mountFilmView({ state: unbound.state, viewer: EDITOR, seats: [] });
    await blocked.settle();
    expect(blocked.text()).toContain('waiting on a reference to condition on');
  });

  it('asks the host for the run it can reach, never for the whole film', async () => {
    const store = await seedLongFilm(12);
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    // The shot in hand and the one a click away — not twelve clips in flight.
    expect(view.asked.map((asset) => asset.path)).toEqual([
      '/film/takes/t0.mp4',
      '/film/takes/t1.mp4',
    ]);

    view.click('Shot 6');
    await view.settle();
    expect(view.asked.slice(2).map((asset) => asset.path)).toEqual([
      '/film/takes/t4.mp4',
      '/film/takes/t5.mp4',
      '/film/takes/t6.mp4',
    ]);
    expect(view.screen()).toBe('blob:/film/takes/t5.mp4');
  });

  it('a clip the host will not serve says why in the frame instead of going blank', async () => {
    const store = await seedFilm();
    const view = await mountFilmView(
      { state: store.state, viewer: EDITOR, seats: [] },
      {
        media: () => ({
          status: 'refused',
          reason: 'asset_changed',
          message: 'That take has been rewritten since the cut pinned it.',
        }),
      },
    );
    await view.settle();
    expect(view.playing()).toEqual([]);
    expect(view.text()).toContain('That take has been rewritten since the cut pinned it.');
  });

  it('reads where each shot stands off the document, and counts it in the header', async () => {
    const { view } = await openFilm();
    const text = view.text();
    expect(text).toContain('settled');
    expect(text).toContain('1 without a take');
    expect(text).toContain('1 stale');
    expect(text).toContain('1 open note');
  });

  it('a stale take names the axis that moved, and offers the restore that owes no render', async () => {
    const { view } = await openFilm();
    view.click('Hands on dough');
    await view.settle();
    // The whole sentence, because 'prompt' alone also matches the Prompt button.
    expect(view.text()).toContain('Take t2 is stale — since it was rendered, the prompt changed.');
    expect(view.labels()).toContain('Restore the shot to this take');
    // A stale shot still plays: the room judges the drift against the frame.
    expect(view.screen()).toBe('blob:/film/takes/t2.mp4');
  });

  it('reads a take stale on several axes as one sentence, and restores every one of them', async () => {
    const store = await seedMultiAxisStale();
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    expect(view.text()).toContain(
      'Take t1 is stale — since it was rendered, the prompt changed, extra was dropped and lead ' +
        'was bound.',
    );

    view.click('Restore the shot to this take');
    await view.settle();
    expect(view.calls.map((call) => call.name)).toEqual([
      'set_prompt',
      'bind_shot_entity',
      'unbind_shot_entity',
      'select_take',
    ]);

    const replay = await seedMultiAxisStale();
    for (const call of view.calls) await apply(replay, call.name, call.input);
    const after = await mountFilmView({ state: replay.state, viewer: EDITOR, seats: [] });
    expect(after.text()).not.toContain('is stale');
  });

  it('a take stale on the route says a re-render is owed instead of offering a restore', async () => {
    // A film of one shot, so the only restore offer that could appear is this
    // shot's — and the route is an axis no edit here can put back.
    const store = makeStore();
    await apply(store, 'add_shot', { shot: shot('Kitchen wide'), clip: clip(SETTLED) });
    await apply(store, 'select_take', { shotId: SETTLED, take: take('t1') });
    await apply(store, 'set_recipe', {
      shotId: SETTLED,
      route: { model: 'google-veo', quality: 'final' },
      conditioning: { mode: 'prompt' },
      keyframeRecipe: null,
    });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    expect(view.text()).toContain('Take t1 is stale — since it was rendered, the route changed.');
    expect(view.text()).toContain('only a re-render settles this one');
    expect(view.labels()).not.toContain('Restore the shot to this take');
  });

  it('the strip carries the holds and dissolves the video track holds, and the beds under it', async () => {
    const store = await seedFilm();
    await apply(store, 'add_timeline_item', {
      trackIndex: 0,
      item: { kind: 'gap', duration: { value: 24, rate: 24 } },
    });
    await apply(store, 'add_timeline_item', {
      trackIndex: 0,
      item: {
        kind: 'transition',
        style: 'dissolve',
        inOffset: { value: 12, rate: 24 },
        outOffset: { value: 12, rate: 24 },
      },
    });
    await apply(store, 'add_timeline_item', {
      trackIndex: 1,
      item: {
        kind: 'audio',
        asset: SCORE,
        sourceRange: { startTime: { value: 0, rate: 24 }, duration: { value: 288, rate: 24 } },
        gainDb: -6,
      },
    });

    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    const text = view.text();
    expect(text).toContain('hold 1s');
    expect(text).toContain('dissolve');
    expect(text).toContain('A1');
    expect(text).toContain('score.wav · -6 dB');
  });

  it('a note carries the shot it was left on, and puts that shot back on the screen', async () => {
    const store = await seedFilm();
    await apply(store, 'add_marker', {
      markerId: 'mk_aaa111',
      marker: { shotId: STALE, at: { value: 120, rate: 24 }, comment: 'the dough reads flat' },
    });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    expect(view.screen()).toBe('blob:/film/takes/t1.mp4');

    // The second note is the one on the second shot — the first sits on shot one.
    view.click('Show', 1);
    await view.settle();
    expect(view.screen()).toBe('blob:/film/takes/t2.mp4');
    expect(view.text()).toContain('2. Hands on dough');
  });

  it('lists open notes in the order the cut plays them, not the order their ids sort', async () => {
    const store = await seedFilm();
    await apply(store, 'add_marker', {
      markerId: 'mk_aaa111',
      marker: { shotId: WAITING, at: { value: 240, rate: 24 }, comment: 'the door lands late' },
    });
    await apply(store, 'add_marker', {
      markerId: 'mk_zzz999',
      marker: { shotId: STALE, at: { value: 120, rate: 24 }, comment: 'the dough reads flat' },
    });

    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    const text = view.text();
    // 0:00.5 · 0:05.0 · 0:10.0 — the ids sort the other way round.
    expect(text.indexOf('the sodium reads too green')).toBeLessThan(
      text.indexOf('the dough reads flat'),
    );
    expect(text.indexOf('the dough reads flat')).toBeLessThan(text.indexOf('the door lands late'));
  });

  it('a viewer watches the whole cut and is offered no way to change it', async () => {
    const { view } = await openFilm({
      userId: randomUUID(),
      spaceRole: 'viewer',
      appletRoles: ['reviewer'],
    });
    expect(view.text()).toContain('View only');
    expect(view.screen()).toBe('blob:/film/takes/t1.mp4');
    // Taking another shot in hand is watching, not writing — it stays reachable.
    view.click('Hands on dough');
    await view.settle();
    expect(view.screen()).toBe('blob:/film/takes/t2.mp4');
    for (const control of ['Trim', 'Timing', 'Prompt', 'Grade', 'Remove', 'Resolve', 'Move']) {
      expect(view.labels().filter((label) => label.includes(control))).toEqual([]);
    }
  });
});

// ============================================================================
// Text on demand
// ============================================================================

describe('film view — the prompt is reference material, not the surface', () => {
  it('prints no prompt across the film, and hands the one being worked on when asked', async () => {
    const { view } = await openFilm();
    expect(view.text()).not.toContain('a kitchen at dawn');
    expect(view.text()).not.toContain('hands folding dough at dusk');

    view.click('Prompt');
    expect(view.text()).toContain('Saving a different prompt makes the selected take stale.');
    expect(view.labels()).toContain('Save the prompt');
  });

  it('drops a draft written against the shot the room has stopped looking at', async () => {
    const { view } = await openFilm();
    view.click('Prompt');
    view.fill('What this shot shows', 'a kitchen at midnight');
    view.click('Hands on dough');
    await view.settle();
    expect(view.labels()).not.toContain('Save the prompt');
    expect(view.calls).toEqual([]);
  });
});

// ============================================================================
// Editing it — every command replayed through the real gateway
// ============================================================================

describe('film view — what it sends is what the platform accepts', () => {
  it('rewrites a prompt', async () => {
    const calls = await drive((view) => {
      view.click('Prompt');
      view.fill('What this shot shows', 'a kitchen at midnight');
      view.fill('What to keep out of it', 'daylight');
      view.click('Save the prompt');
    });
    expect(calls.map((call) => call.name)).toEqual(['set_prompt']);
    expect(calls[0]?.input).toMatchObject({
      shotId: SETTLED,
      prompt: 'a kitchen at midnight',
      negativePrompt: 'daylight',
    });
  });

  it('sets a shot’s generated length and playback speed', async () => {
    const calls = await drive((view) => {
      view.click('Timing');
      view.fill('generated length in seconds', '3.5');
      view.fill('playback speed', '0.5');
      view.click('Save the timing');
    });
    expect(calls.map((call) => call.name)).toEqual(['set_timing']);
    expect(calls[0]?.input).toMatchObject({ shotId: SETTLED, durationSeconds: 3.5, speed: 0.5 });
  });

  it('trims a clip in seconds and sends frames at the rate the clip already carries', async () => {
    const calls = await drive((view) => {
      view.click('Trim');
      view.fill('trim start in seconds', '0.5');
      view.fill('trim duration in seconds', '2.5');
      view.click('Save the trim');
    });
    expect(calls.map((call) => call.name)).toEqual(['trim_clip']);
    expect(calls[0]?.input).toMatchObject({
      shotId: SETTLED,
      trackIndex: 0,
      itemIndex: 0,
      sourceRange: {
        startTime: { value: 12, rate: 24 },
        duration: { value: 60, rate: 24 },
      },
    });
  });

  it('binds an entity from the library into a role, at the version the library is pinned to', async () => {
    const calls = await drive((view) => {
      view.click('Roles');
      view.fill('role, e.g. lead', 'lead');
      view.click('Bind');
    });
    expect(calls.map((call) => call.name)).toEqual(['bind_shot_entity']);
    expect(calls[0]?.input).toEqual({ shotId: SETTLED, role: 'lead', entity: MARA });
  });

  it('drops a role from the shot that holds it', async () => {
    const calls = await drive((view) => {
      view.click('Door opens');
      view.click('Roles');
      view.click('Unbind');
    });
    expect(calls.map((call) => call.name)).toEqual(['unbind_shot_entity']);
    expect(calls[0]?.input).toEqual({ shotId: WAITING, role: 'lead' });
  });

  it('leaves a timecoded note on a shot, with a freshly minted id', async () => {
    const calls = await drive((view) => {
      view.click('Note');
      view.fill('A note on this shot', 'the door reads too fast');
      view.click('Leave the note');
    });
    expect(calls.map((call) => call.name)).toEqual(['add_marker']);
    const input = calls[0]?.input as { markerId: string; marker: Record<string, unknown> };
    expect(input.markerId).toMatch(/^mk_[0-9a-z]{6,20}$/);
    expect(input.marker).toMatchObject({ shotId: SETTLED, comment: 'the door reads too fast' });
  });

  it('leaves a note on the film itself, bound to no shot', async () => {
    const calls = await drive((view) => {
      view.click('Leave a note on the film');
      view.fill('A note on the cut as a whole', 'the second act drags');
      view.click('Leave the note');
    });
    expect(calls.map((call) => call.name)).toEqual(['add_marker']);
    const input = calls[0]?.input as { marker: { shotId: unknown } };
    expect(input.marker.shotId).toBeNull();
  });

  it('resolves an open note', async () => {
    const calls = await drive((view) => {
      view.click('Resolve');
    });
    expect(calls).toEqual([
      { name: 'resolve_marker', input: { markerId: 'mk_note01' }, extras: undefined },
    ]);
  });

  it('moves a clip, naming the clip that is actually at the position', async () => {
    const calls = await drive((view) => {
      view.click('Hands on dough');
      view.click('Move ←');
    });
    expect(calls.map((call) => call.name)).toEqual(['reorder_shot']);
    expect(calls[0]?.input).toEqual({
      trackIndex: 0,
      fromIndex: 1,
      toIndex: 0,
      clip: clip(STALE),
    });
  });

  it('swaps two shots across a hold, and the hold stays where it was', async () => {
    const store = await seedWithHold();
    expect(videoTrack(store)).toEqual([`clip ${SETTLED}`, 'gap', `clip ${STALE}`]);

    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    view.click('Move →');
    await view.settle();

    const replay = await seedWithHold();
    for (const call of view.calls) await apply(replay, call.name, call.input);
    expect(videoTrack(replay)).toEqual([`clip ${STALE}`, 'gap', `clip ${SETTLED}`]);
  });

  it('swaps back up across the same hold', async () => {
    const store = await seedWithHold();
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    view.click('Hands on dough');
    view.click('Move ←');
    await view.settle();

    const replay = await seedWithHold();
    for (const call of view.calls) await apply(replay, call.name, call.input);
    expect(videoTrack(replay)).toEqual([`clip ${STALE}`, 'gap', `clip ${SETTLED}`]);
  });

  it('removes a shot only once the removal is confirmed', async () => {
    const { view } = await openFilm();
    view.click('Remove');
    expect(view.calls).toEqual([]);
    expect(view.text()).toContain('Remove the shot and its clip?');

    const calls = await drive((driven) => {
      driven.click('Remove');
      driven.click('Remove');
    });
    expect(calls.map((call) => call.name)).toEqual(['remove_shot']);
    expect(calls[0]?.input).toEqual({ shotId: SETTLED, trackIndex: 0, itemIndex: 0 });
  });

  it('sets the grade for the whole film', async () => {
    const calls = await drive((view) => {
      view.click('Grade');
      view.fill('The look, applied to every shot', 'warm tungsten interiors');
      view.fill('Why this look', 'the bakery should feel like the only warm room');
      view.click('Set the grade');
    });
    expect(calls.map((call) => call.name)).toEqual(['set_grade']);
    expect(calls[0]?.input).toEqual({
      grade: {
        look: 'warm tungsten interiors',
        note: 'the bakery should feel like the only warm room',
        plate: null,
      },
    });
  });

  it('tells whoever is not the director who owns the look, rather than blocking them', async () => {
    const { view } = await openFilm();
    view.click('Grade');
    expect(view.text()).toContain('The director owns the look');
    expect(view.labels()).toContain('Set the grade');
  });

  it('restores a stale shot to its take, and the take it re-selects passes the gateway’s own test', async () => {
    const calls = await drive((view) => {
      view.click('Hands on dough');
      view.click('Restore the shot to this take');
    });
    // The prompt goes back first; only then does the take's provenance match
    // the shot again, which is exactly what select_take asserts.
    expect(calls.map((call) => call.name)).toEqual(['set_prompt', 'select_take']);
    expect(calls[0]?.input).toMatchObject({ shotId: STALE, prompt: RECIPE.prompt });
    expect(calls[1]?.input).toEqual({ shotId: STALE, take: take('t2') });
    expect(calls[1]?.extras).toMatchObject({ outcome: expect.stringContaining('t2') });
  });

  it('a restored shot reads as settled, because staleness is recomputed and never stored', async () => {
    const store = await seedFilm();
    const { view } = await openFilm();
    view.click('Hands on dough');
    view.click('Restore the shot to this take');
    await view.settle();
    for (const call of view.calls) await apply(store, call.name, call.input);

    const after = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    expect(after.text()).not.toContain('Take t2 is stale');
    expect(after.text()).not.toContain('1 stale');
  });
});

// ============================================================================
// A control that cannot act says so, rather than swallowing the click
// ============================================================================

describe('film view — no button lies about what it will do', () => {
  it('will not save a timing the platform would refuse', async () => {
    const { view } = await openFilm();
    view.click('Timing');
    expect(view.labels()).toContain('Save the timing');

    view.fill('playback speed', '');
    expect(view.labels()).not.toContain('Save the timing');
    expect(view.text()).toContain('A generated length runs above 0');

    view.fill('playback speed', '0.5');
    view.fill('generated length in seconds', '45');
    expect(view.labels()).not.toContain('Save the timing');

    view.fill('generated length in seconds', '3.5');
    expect(view.labels()).toContain('Save the timing');
    expect(view.calls).toEqual([]);
  });

  it('will not save a trim typed as words', async () => {
    const { view } = await openFilm();
    view.click('Trim');
    expect(view.labels()).toContain('Save the trim');

    view.fill('trim duration in seconds', 'two and a half');
    expect(view.labels()).not.toContain('Save the trim');
    expect(view.text()).toContain('A trim starts at 0 seconds or later');

    view.fill('trim duration in seconds', '2.5');
    expect(view.labels()).toContain('Save the trim');
    expect(view.calls).toEqual([]);
  });

  it('says a change is in flight while a chain of acts runs', async () => {
    const { view } = await openFilm();
    view.click('Hands on dough');
    view.click('Restore the shot to this take');
    expect(view.text()).toContain('sending…');
    // The chain owns the whole run, so the moves stay out of reach until it ends.
    expect(view.labels()).not.toContain('Move →');

    await view.settle();
    expect(view.text()).not.toContain('sending…');
    expect(view.labels()).toContain('Move →');
  });
});

// ============================================================================
// A refusal is surfaced, never swallowed
// ============================================================================

describe('film view — a refusal reaches the room', () => {
  it('shows what the platform said when it refuses', async () => {
    const store = await seedFilm();
    const view = await mountFilmView(
      { state: store.state, viewer: EDITOR, seats: [] },
      {
        answer: {
          status: 'rejected',
          validation: ['the note map is full — resolve one before adding more'],
        },
      },
    );
    view.click('Resolve');
    await view.settle();
    expect(view.text()).toContain('the note map is full — resolve one before adding more');
    expect(view.labels()).toContain('Dismiss');
  });

  it('says a refusal happened even when the platform gave no detail', async () => {
    const store = await seedFilm();
    const view = await mountFilmView(
      { state: store.state, viewer: EDITOR, seats: [] },
      { answer: { status: 'rejected' } },
    );
    view.click('Resolve');
    await view.settle();
    expect(view.text()).toContain('refused the change');
  });

  it('tells the room the cut moved rather than silently dropping the edit', async () => {
    const store = await seedFilm();
    const view = await mountFilmView(
      { state: store.state, viewer: EDITOR, seats: [] },
      { answer: { status: 'conflict', currentVersion: 99 } },
    );
    view.click('Resolve');
    await view.settle();
    expect(view.text()).toContain('The cut moved while you were editing');
  });
});

describe('film view — what a shot is waiting on, and what a regrade does to a settled one', () => {
  const GRADED = { look: 'dawn', note: '', plate: GRADE_PLATE };

  async function oneShot(overrides: Record<string, unknown>): Promise<Store> {
    const store = makeStore();
    await apply(store, 'set_grade', { grade: GRADED });
    await apply(store, 'add_shot', {
      shot: { ...shot('Only shot'), ...overrides },
      clip: clip(SETTLED),
    });
    return store;
  }

  async function lineOf(store: Store): Promise<string> {
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    return view.text();
  }

  it('a shot that animates a frame and has no recipe says so, rather than naming the take', async () => {
    // It cannot be dispatched at all: there is no way to make the frame the
    // only renderable form of this shot needs.
    const store = await oneShot({
      conditioning: { mode: 'reference', endFrame: null },
      keyframeRecipe: null,
      entities: { lead: MARA },
    });
    expect(await lineOf(store)).toContain('waiting on a keyframe recipe');
  });

  it('a shot that animates nothing is never reported as waiting on a frame', async () => {
    // A recipe can sit on a prompt-mode shot — the two are separate members —
    // and reading it as an owed frame would send a pass to buy a still nothing
    // will animate.
    const store = await oneShot({
      conditioning: { mode: 'prompt' },
      keyframeRecipe: KEYFRAME_RECIPE,
    });
    const text = await lineOf(store);
    expect(text).toContain('waiting on its first take');
    expect(text).not.toContain('keyframe');
  });

  it('turning the shot restales its frame — the still faces the direction the shot left', async () => {
    const recipe = { ...KEYFRAME_RECIPE, gradePlate: GRADE_PLATE };
    const store = await oneShot({
      conditioning: { mode: 'reference', endFrame: null },
      keyframeRecipe: recipe,
      entities: { lead: MARA },
      keyframe: {
        asset: { path: '/film/frames/one.png', version: 1, contentHash: 'stillone01' },
        renderedFrom: { recipe, entities: { lead: MARA }, screenDirection: 'none' },
      },
    });
    // The screen shows the words rather than the still, so the reading is legible.
    const line = async () => {
      const view = await mountFilmView(
        { state: store.state, viewer: EDITOR, seats: [] },
        { media: () => ({ status: 'refused', message: 'not served here' }) },
      );
      await view.settle();
      return view.text();
    };
    expect(await line()).toContain('waiting on its first take');

    await apply(store, 'set_prompt', {
      shotId: SETTLED,
      prompt: RECIPE.prompt,
      negativePrompt: '',
      screenDirection: 'toward',
    });
    expect(await line()).toContain('waiting on a new keyframe');
  });

  it('regrading the film unsettles a shot whose take and frame still agree with each other', async () => {
    const recipe = { ...KEYFRAME_RECIPE, gradePlate: GRADE_PLATE };
    const keyframe = {
      asset: { path: '/film/frames/one.png', version: 1, contentHash: 'stillone01' },
      renderedFrom: { recipe, entities: {}, screenDirection: 'none' },
    };
    const store = await oneShot({
      conditioning: { mode: 'reference', endFrame: null },
      keyframeRecipe: recipe,
      keyframe,
    });
    await apply(store, 'select_take', {
      shotId: SETTLED,
      take: take('t1', {
        renderedFrom: {
          ...RECIPE,
          conditioning: { mode: 'reference', endFrame: null },
          keyframe: keyframe.asset,
        },
      }),
    });
    expect(await lineOf(store)).not.toContain('is stale');

    // Neither the shot nor the frame moves, so every pairwise comparison still
    // matches — only the film has left the look behind.
    await apply(store, 'set_grade', {
      grade: { ...GRADED, plate: { ...GRADE_PLATE, version: 2, contentHash: 'gradeplate02' } },
    });
    expect(await lineOf(store)).toContain('the frame it animates no longer answers the film');
  });
});

describe('film view — a rebound role stays restorable even on a shot that animates a frame', () => {
  it('offers the restore, because rebinding back settles the frame as well as the take', async () => {
    const recipe = { ...KEYFRAME_RECIPE, gradePlate: GRADE_PLATE };
    const keyframe = {
      asset: { path: '/film/frames/one.png', version: 1, contentHash: 'stillone01' },
      renderedFrom: { recipe, entities: { lead: MARA }, screenDirection: 'none' },
    };
    const store = makeStore();
    await apply(store, 'set_grade', { grade: { look: 'dawn', note: '', plate: GRADE_PLATE } });
    await apply(store, 'add_shot', {
      shot: {
        ...shot('Only shot'),
        conditioning: { mode: 'reference', endFrame: null },
        keyframeRecipe: recipe,
        keyframe,
      },
      clip: clip(SETTLED),
    });
    await apply(store, 'bind_shot_entity', { shotId: SETTLED, role: 'lead', entity: MARA });
    await apply(store, 'select_take', {
      shotId: SETTLED,
      take: take('t1', {
        renderedFrom: {
          ...RECIPE,
          conditioning: { mode: 'reference', endFrame: null },
          keyframe: keyframe.asset,
          entities: { lead: MARA },
        },
      }),
    });

    // Only the binding moves. The recipe and the film's plate are untouched, so
    // the frame still answers the film and the rebind is undoable.
    const repinned = { ...MARA, pins: [{ ...PIN, version: 2 }] };
    await apply(store, 'bind_shot_entity', { shotId: SETTLED, role: 'lead', entity: repinned });

    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    expect(view.text()).toContain('lead was rebound');
    expect(view.text()).not.toContain('no longer answers the film');
    expect(view.labels()).toContain('Restore the shot to this take');
  });
});

// ============================================================================
// The cut plays in order, as an animatic
// ============================================================================

describe('film view — watching the cut', () => {
  /** Three shots: a take, then a shot with only a keyframe, then a take. */
  async function seedAnimatic(): Promise<Store> {
    const store = makeStore();
    const still = { path: '/film/frames/mid.png', version: 1, contentHash: 'stillmid001' };
    await apply(store, 'add_shot', { shot: shot('One'), clip: clip(SETTLED) });
    await apply(store, 'select_take', { shotId: SETTLED, take: take('t1') });
    await apply(store, 'add_shot', {
      shot: {
        ...shot('Two'),
        conditioning: { mode: 'reference', endFrame: null },
        keyframeRecipe: KEYFRAME_RECIPE,
        keyframe: {
          asset: still,
          renderedFrom: { recipe: KEYFRAME_RECIPE, entities: {}, screenDirection: 'none' },
        },
      },
      clip: clip(STALE),
    });
    await apply(store, 'add_shot', { shot: shot('Three'), clip: clip(WAITING) });
    await apply(store, 'select_take', { shotId: WAITING, take: take('t3') });
    return store;
  }

  async function watch(store: Store): Promise<MountedView> {
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    view.click('Watch the cut');
    await view.settle();
    return view;
  }

  it('plays the first take, holds the next shot as a still, then plays the last', async () => {
    const view = await watch(await seedAnimatic());
    expect(view.screen()).toContain('t1.mp4');

    // A clip ends itself through the element; the sequence moves on from there.
    view.endClip();
    await view.settle();
    expect(view.screen()).toBeNull();
    expect(view.still()).toContain('mid.png');

    // The still is held for the shot's own length, because it occupies that
    // length in the cut — 96 frames at 24fps.
    view.tick(3999);
    expect(view.still()).toContain('mid.png');
    view.tick(2);
    await view.settle();
    expect(view.screen()).toContain('t3.mp4');
  });

  it('stops at the end of the track rather than looping', async () => {
    const view = await watch(await seedAnimatic());
    view.endClip();
    await view.settle();
    view.tick(4001);
    await view.settle();
    expect(view.screen()).toContain('t3.mp4');

    view.endClip();
    await view.settle();
    expect(view.labels()).toContain('Watch the cut');
    expect(view.labels()).not.toContain('Stop the cut');
  });

  it('holds black across a gap, for as long as the gap runs', async () => {
    const store = await seedWithHold();
    await apply(store, 'select_take', { shotId: SETTLED, take: take('t1') });
    await apply(store, 'select_take', { shotId: STALE, take: take('t2') });
    const view = await watch(store);
    expect(view.screen()).toContain('t1.mp4');

    view.endClip();
    await view.settle();
    // The gap takes time off the film's clock, so playing straight through
    // would report a cut the document does not have.
    expect(view.text()).toContain('of black');
    expect(view.screen()).toBeNull();

    view.tick(2000);
    await view.settle();
    expect(view.screen()).toContain('t2.mp4');
  });

  it('says it is showing stills, so a held frame does not read as a frozen clip', async () => {
    const view = await mountFilmView({
      state: (await seedAnimatic()).state,
      viewer: EDITOR,
      seats: [],
    });
    await view.settle();
    expect(view.text()).toContain('1 shot holds a still, not a clip');
  });

  it('starts the clip, rather than trusting an attribute to start it', async () => {
    // The element is imperative: flipping autoplay on one that is already
    // loaded and paused does nothing, so a cut that only set the attribute
    // would sit on its first shot forever with the transport reading Playing.
    const view = await mountFilmView({
      state: (await seedAnimatic()).state,
      viewer: EDITOR,
      seats: [],
    });
    await view.settle();
    expect(view.started()).toBe(0);

    view.click('Watch the cut');
    await view.settle();
    expect(view.started()).toBe(1);
  });

  it('starts every clip the cut reaches, not only the first', async () => {
    // Advancing changes the source on the same element. React keeps that node,
    // so nothing about the element itself changes — a view that only started
    // playback when the element did would stall on the second clip.
    const view = await watch(await seedAnimatic());
    expect(view.started()).toBe(1);

    view.endClip();
    await view.settle();
    view.tick(4001);
    await view.settle();
    expect(view.screen()).toContain('t3.mp4');
    expect(view.started()).toBe(2);
  });

  it('holds a shot whose take the host will not serve, instead of stopping there', async () => {
    const store = await seedAnimatic();
    const view = await mountFilmView(
      { state: store.state, viewer: EDITOR, seats: [] },
      {
        // The last shot's clip is refused; the sequence has to carry on past it.
        media: (asset) =>
          asset.path.includes('t3')
            ? { status: 'refused', message: 'evicted' }
            : { status: 'ready', url: 'blob:' + asset.path },
      },
    );
    await view.settle();
    view.click('Watch the cut');
    await view.settle();

    view.endClip();
    await view.settle();
    view.tick(4001);
    await view.settle();
    // Shot 3's take cannot play. Its length still passes, and the cut ends
    // rather than sitting on a refusal with the transport reading Playing.
    expect(view.text()).toContain('evicted');
    view.tick(4001);
    await view.settle();
    expect(view.labels()).toContain('Watch the cut');
  });

  it('holds the black after the last clip, because it is still the film', async () => {
    const store = makeStore();
    await apply(store, 'add_shot', { shot: shot('Only'), clip: clip(SETTLED) });
    await apply(store, 'select_take', { shotId: SETTLED, take: take('t1') });
    await apply(store, 'add_timeline_item', {
      trackIndex: 0,
      item: { kind: 'gap', duration: { value: 48, rate: 24 } },
    });
    const view = await watch(store);

    view.endClip();
    await view.settle();
    // The gap is in the runtime the header reports, so stopping on the final
    // frame would play a cut shorter than the film says it is.
    expect(view.text()).toContain('of black');
    expect(view.labels()).toContain('Stop the cut');

    view.tick(2001);
    await view.settle();
    expect(view.labels()).toContain('Watch the cut');
  });

  it('gives no time to a clip the cut gives no time to', async () => {
    const store = await seedAnimatic();
    // A zero-length clip has its out-point behind its in-point, so the element
    // would play the whole file before ending.
    await apply(store, 'trim_clip', {
      shotId: SETTLED,
      trackIndex: 0,
      itemIndex: 0,
      sourceRange: { startTime: { value: 0, rate: 24 }, duration: { value: 0, rate: 24 } },
    });
    const view = await watch(store);

    view.tick(1);
    await view.settle();
    expect(view.still()).toContain('mid.png');
  });

  it('stops when the shot it started from is removed by another seat', async () => {
    const store = await seedAnimatic();
    // Playback began on the default first shot, so nothing was ever clicked —
    // the pointer has to be pinned or the removal reads as an ordinary move.
    const view = await watch(store);
    expect(view.started()).toBe(1);

    await apply(store, 'remove_shot', { shotId: SETTLED, trackIndex: 0, itemIndex: 0 });
    const after = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await after.settle();
    expect(after.labels()).toContain('Watch the cut');
  });

  it('asks the host for no more than the window, at every step of the cut', async () => {
    const store = await seedLongFilm(12);
    const view = await watch(store);
    // Cumulative asks grow with the cut; what must stay bounded is how many a
    // single step puts in flight.
    let seen = view.asked.length;
    for (let step = 0; step < 4; step += 1) {
      view.endClip();
      await view.settle();
      expect(view.asked.length - seen).toBeLessThanOrEqual(3);
      seen = view.asked.length;
    }
  });
});

// ============================================================================
// Continuity is read at the cut
// ============================================================================

describe('film view — continuity is read at the cut, inside a scene and only there', () => {
  const KITCHEN_PIN = { path: '/film/sets/kitchen.png', version: 1, contentHash: 'kitchenpin01' };
  const YARD_PIN = { path: '/film/sets/yard.png', version: 1, contentHash: 'yardpin00001' };
  const KITCHEN = { kind: 'set', name: 'The kitchen', pins: [KITCHEN_PIN] };
  const YARD = { kind: 'set', name: 'The yard', pins: [YARD_PIN] };

  /** Two adjacent shots, directions opposed, scene membership decided per test. */
  async function seedPair(options: {
    scenes: [string | null, string | null];
    entities?: [Record<string, unknown>, Record<string, unknown>];
  }): Promise<Store> {
    const store = makeStore();
    await apply(store, 'add_scene', {
      sceneId: 'sc_nightwalk1',
      scene: { name: 'The night walk', note: '' },
    });
    await apply(store, 'add_scene', {
      sceneId: 'sc_nightwalk2',
      scene: { name: 'The walk back', note: '' },
    });
    const [entitiesA, entitiesB] = options.entities ?? [{}, {}];
    await apply(store, 'add_shot', {
      shot: { ...shot('Going'), screenDirection: 'left_to_right', entities: entitiesA },
      clip: clip(SETTLED),
    });
    await apply(store, 'add_shot', {
      shot: { ...shot('Coming back'), screenDirection: 'right_to_left', entities: entitiesB },
      clip: clip(STALE),
    });
    const [sceneA, sceneB] = options.scenes;
    if (sceneA) await apply(store, 'set_scene', { shotId: SETTLED, sceneId: sceneA });
    if (sceneB) await apply(store, 'set_scene', { shotId: STALE, sceneId: sceneB });
    return store;
  }

  it('opposed directions across a cut in one scene are a note on the header and on the shot', async () => {
    const store = await seedPair({ scenes: ['sc_nightwalk1', 'sc_nightwalk1'] });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    const text = view.text();
    expect(text).toContain('1 continuity note');
    expect(text).toContain(
      'Coming back reverses the direction of travel against Going inside one scene',
    );
    expect(text).toContain('Sometimes the flip is the shot');
  });

  it('the same pair split across scenes, or standing in none, raises nothing', async () => {
    for (const scenes of [
      ['sc_nightwalk1', 'sc_nightwalk2'],
      [null, null],
    ] as const) {
      const store = await seedPair({ scenes: [...scenes] as [string | null, string | null] });
      const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
      await view.settle();
      expect(view.text()).not.toContain('continuity note');
    }
  });

  it('two places inside one scene read as a jump, named by both sets', async () => {
    const store = await seedPair({
      scenes: ['sc_nightwalk1', 'sc_nightwalk1'],
      entities: [{ where: KITCHEN }, { where: YARD }],
    });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    const text = view.text();
    expect(text).toContain('2 continuity notes');
    expect(text).toContain('Coming back stands in The yard while Going stands in The kitchen');
  });

  it('the same two sets bound in either order are one place, not a jump', async () => {
    const store = await seedPair({
      scenes: ['sc_nightwalk1', 'sc_nightwalk1'],
      entities: [
        { interior: KITCHEN, backdrop: YARD },
        { backdrop: YARD, interior: KITCHEN },
      ],
    });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    expect(view.text()).not.toContain('one scene, two places');
  });

  it('a place is its pinned bytes, not its label', async () => {
    // Two different sets sharing one name are still two places; one set
    // renamed between shots is still one. A name key reads both wrong.
    const otherKitchen = {
      kind: 'set',
      name: 'The kitchen',
      pins: [{ path: '/film/sets/kitchen-b.png', version: 1, contentHash: 'kitchenpinb1' }],
    };
    const sameName = await seedPair({
      scenes: ['sc_nightwalk1', 'sc_nightwalk1'],
      entities: [{ where: KITCHEN }, { where: otherKitchen }],
    });
    const jump = await mountFilmView({ state: sameName.state, viewer: EDITOR, seats: [] });
    await jump.settle();
    expect(jump.text()).toContain('one scene, two places');

    const renamed = { ...KITCHEN, name: 'The bakery' };
    const samePins = await seedPair({
      scenes: ['sc_nightwalk1', 'sc_nightwalk1'],
      entities: [{ where: KITCHEN }, { where: renamed }],
    });
    const still = await mountFilmView({ state: samePins.state, viewer: EDITOR, seats: [] });
    await still.settle();
    expect(still.text()).not.toContain('one scene, two places');
  });

  it('a location jump does not borrow the flip’s dismissal line', async () => {
    const store = await seedPair({
      scenes: ['sc_nightwalk1', 'sc_nightwalk1'],
      entities: [{ where: KITCHEN }, { where: YARD }],
    });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    const text = view.text();
    const jumpAt = text.indexOf('one scene, two places');
    expect(jumpAt).toBeGreaterThan(-1);
    // The flip note (also present in this pair) keeps its line; the jump's
    // sentence ends without it.
    expect(text.slice(jumpAt, jumpAt + 120)).not.toContain('Sometimes the flip is the shot');
  });

  it('a direction change restales the take, and the restore sends the direction back', async () => {
    const store = makeStore();
    await apply(store, 'add_shot', {
      shot: { ...shot('Going'), screenDirection: 'left_to_right' },
      clip: clip(SETTLED),
    });
    await apply(store, 'select_take', {
      shotId: SETTLED,
      take: take('t1', {
        renderedFrom: { ...RECIPE, screenDirection: 'left_to_right' },
      }),
    });
    await apply(store, 'set_prompt', {
      shotId: SETTLED,
      prompt: RECIPE.prompt,
      negativePrompt: '',
      screenDirection: 'right_to_left',
    });

    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    expect(view.text()).toContain(
      'Take t1 is stale — since it was rendered, the direction of travel changed.',
    );

    view.click('Restore the shot to this take');
    await view.settle();
    expect(view.calls.map((call) => call.name)).toEqual(['set_prompt', 'select_take']);
    expect(view.calls[0]?.input).toMatchObject({
      shotId: SETTLED,
      screenDirection: 'left_to_right',
    });
    // The restore is a real write: replay it through the gateway.
    for (const call of view.calls) await apply(store, call.name, call.input);
    const shots = store.state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots[SETTLED]!['screenDirection']).toBe('left_to_right');
  });
});

// ============================================================================
// The world is on the board
// ============================================================================

describe('film view — the world is visible before a single shot is', () => {
  const FRANK_PIN = { path: '/film/entities/frank.png', version: 1, contentHash: 'frankpin0001' };
  const ALLEY_PIN = { path: '/film/sets/alley.png', version: 1, contentHash: 'alleypin0001' };

  it('shows the grade plate and every library entity as plates with names', async () => {
    const store = makeStore();
    await apply(store, 'set_grade', {
      grade: { look: 'amber sodium noir', note: '', plate: GRADE_PLATE },
    });
    await apply(store, 'bind_entity', {
      entityKey: 'frank',
      entity: { kind: 'character', name: 'Frank', pins: [FRANK_PIN] },
    });
    await apply(store, 'bind_entity', {
      entityKey: 'alley',
      entity: { kind: 'set', name: 'The alley', pins: [ALLEY_PIN] },
    });

    const requested: string[] = [];
    const view = await mountFilmView(
      { state: store.state, viewer: EDITOR, seats: [] },
      {
        media: (asset) => {
          requested.push(asset.path);
          return { status: 'ready', url: `blob:${asset.path}` };
        },
      },
    );
    await view.settle();

    const text = view.text();
    expect(text).toContain('the grade');
    expect(text).toContain('Frank · character');
    expect(text).toContain('The alley · set');
    expect(requested).toContain(GRADE_PLATE.path);
    expect(requested).toContain(FRANK_PIN.path);
    expect(requested).toContain(ALLEY_PIN.path);
    // The plates render as stills, not as labels waiting on nothing.
    expect(view.still()).toContain('blob:');
  });

  it('an empty film shows no world row rather than an empty frame', async () => {
    const view = await mountFilmView({
      state: structuredClone(FILM_DEFINITION.initialState),
      viewer: EDITOR,
      seats: [],
    });
    await view.settle();
    expect(view.text()).not.toContain('the grade');
    expect(view.still()).toBeNull();
  });
});

describe('film view — a shot blind to its bindings is said so before it is paid for', () => {
  it('binding a cast the conditioning will not carry warns on the header and the shot', async () => {
    const store = makeStore();
    await apply(store, 'add_shot', { shot: shot('Kitchen wide'), clip: clip(SETTLED) });
    await apply(store, 'bind_shot_entity', { shotId: SETTLED, role: 'lead', entity: MARA });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    const text = view.text();
    expect(text).toContain('1 shot renders without the cast');
    expect(text).toContain('binds Mara and conditions on the prompt alone');
    expect(text).toContain('Reference conditioning is what carries a binding into the frame');
  });

  it('a shot conditioning on its references raises nothing', async () => {
    const store = makeStore();
    await apply(store, 'add_shot', {
      shot: {
        ...shot('Kitchen wide'),
        conditioning: { mode: 'reference', endFrame: null },
        entities: { lead: MARA },
      },
      clip: clip(SETTLED),
    });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    expect(view.text()).not.toContain('renders without the cast');
    expect(view.text()).not.toContain('conditions on the prompt alone');
  });
});

describe('film view — the casting sheet is visible before its plates exist', () => {
  it('a cast entity without a plate shows as awaiting one, and disappears into its plate', async () => {
    const store = makeStore();
    await apply(store, 'draft_casting', {
      entityKey: 'frank',
      casting: {
        kind: 'character',
        name: 'Frank the Courier',
        brief: 'Mid-forties, weathered canvas coat, cross-body satchel, tired eyes.',
      },
    });
    const view = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await view.settle();
    expect(view.text()).toContain('Frank the Courier · character — cast, awaiting its plate');

    await apply(store, 'bind_entity', {
      entityKey: 'frank',
      entity: {
        kind: 'character',
        name: 'Frank the Courier',
        pins: [{ path: '/film/entities/frank.png', version: 1, contentHash: 'frankpin0001' }],
      },
    });
    const plated = await mountFilmView({ state: store.state, viewer: EDITOR, seats: [] });
    await plated.settle();
    expect(plated.text()).toContain('Frank the Courier · character');
    expect(plated.text()).not.toContain('awaiting its plate');
  });
});
