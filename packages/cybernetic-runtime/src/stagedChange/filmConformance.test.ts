import { describe, expect, it } from 'vitest';
import {
  applyAppletStatePatch,
  checkAppletConformance,
  evaluateAppletActionGuard,
  jsonUtf8Bytes,
  materializeAppletTemplatePatch,
  projectAppletAttention,
  projectAppletState,
  validateAgainstAppletSchema,
} from '@aflow/applet-runtime';
import { FILM_DEFINITION, FILM_VIEW_SOURCE } from '@aflow/platform-artifacts';
import { APPLET_STATE_MAX_BYTES, type AppletTemplatePatch } from '@aflow/schemas';

function action(name: string) {
  const found = FILM_DEFINITION.actions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`film declares no action '${name}'`);
  return found;
}

function template(name: string) {
  const patch = action(name).patch;
  if (patch === 'actor_supplied') throw new Error(`'${name}' is not a template action`);
  return (patch as AppletTemplatePatch).template;
}

function validateInput(name: string, input: unknown) {
  return validateAgainstAppletSchema({
    schema: action(name).inputSchema,
    cacheKey: `film-input-${name}`,
    data: input,
  });
}

function validateState(state: Record<string, unknown>) {
  return validateAgainstAppletSchema({
    schema: FILM_DEFINITION.stateSchema,
    cacheKey: 'film-state',
    data: state,
  });
}

/** Act as the gateway does: validate the input, materialize, apply, validate the state. */
function act(
  state: Record<string, unknown>,
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const inputCheck = validateInput(name, input);
  if (!inputCheck.valid)
    throw new Error(`invalid input for '${name}': ${inputCheck.errors.join('; ')}`);
  const next = applyAppletStatePatch(state, materializeAppletTemplatePatch(template(name), input));
  const stateCheck = validateState(next);
  if (!stateCheck.valid)
    throw new Error(`invalid state after '${name}': ${stateCheck.errors.join('; ')}`);
  return next;
}

function pin(path: string, version: number, tail: string) {
  return { path, version, contentHash: `sha256-${tail}`.padEnd(24, '0') };
}

const ADA_V3 = {
  kind: 'character',
  name: 'Ada',
  pins: [pin('/film/entities/ada.md', 3, 'ada3')],
};
const ADA_V4 = {
  kind: 'character',
  name: 'Ada',
  pins: [pin('/film/entities/ada.md', 4, 'ada4')],
};
const BEN_V1 = {
  kind: 'character',
  name: 'Ben',
  pins: [pin('/film/entities/ben.md', 1, 'ben1')],
};

function shotId(index: number): string {
  return `sh_${String(index).padStart(8, '0')}`;
}

const PROMPT = 'Wide shot, Ada crosses a rain-slicked yard at dusk, sodium light, handheld, 35mm';
const NEGATIVE_PROMPT = 'text, watermark, extra fingers';
const ROUTE = { model: 'runware-kling', quality: 'draft' };
const GRADE_PLATE = pin('/film/grade/dusk.png', 1, 'dusk1');
const KEYFRAME_RECIPE = {
  framing: 'Wide, camera low at the yard gate, the far wall filling the top third',
  prompt: 'Ada at the near edge of a rain-slicked yard at dusk, mid-stride',
  route: 'google-pro-image',
  gradePlate: GRADE_PLATE,
};
const KEYFRAME_ASSET = pin('/film/frames/open.png', 1, 'open');
const KEYFRAME = {
  asset: KEYFRAME_ASSET,
  renderedFrom: { recipe: KEYFRAME_RECIPE, entities: { lead: ADA_V3 }, screenDirection: 'toward' },
};
const CONDITIONING = { mode: 'reference', endFrame: null };

function shot(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Ada crosses the yard',
    prompt: PROMPT,
    negativePrompt: NEGATIVE_PROMPT,
    screenDirection: 'toward',
    sceneId: null,
    durationSeconds: 4,
    speed: 1,
    route: ROUTE,
    conditioning: CONDITIONING,
    keyframeRecipe: KEYFRAME_RECIPE,
    keyframe: KEYFRAME,
    entities: { lead: ADA_V3 },
    selectedTake: null,
    takes: null,
    note: '',
    ...overrides,
  };
}

/** A take of the shot as `shot()` builds it — the provenance the gateway will assert. */
function take(id: string, overrides: Record<string, unknown> = {}) {
  return {
    takeId: `tk_${id}`,
    asset: pin(`/film/takes/${id}.mp4`, 1, id.slice(-4)),
    note: '',
    renderedFrom: {
      prompt: PROMPT,
      negativePrompt: NEGATIVE_PROMPT,
      screenDirection: 'toward',
      durationSeconds: 4,
      route: ROUTE,
      conditioning: CONDITIONING,
      keyframe: KEYFRAME_ASSET,
      entities: { lead: ADA_V3 },
    },
    ...overrides,
  };
}

function selectedTakeOf(state: Record<string, unknown>, id: string) {
  const shots = state['shots'] as Record<string, Record<string, unknown>>;
  return shots[id]?.['selectedTake'] as { renderedFrom: Record<string, unknown> } | null;
}

/** Exactly what a review turn does: the shot as it asks now, minus what answered it. */
function staleAxes(state: Record<string, unknown>, id: string): string[] {
  const shot = (state['shots'] as Record<string, Record<string, unknown>>)[id]!;
  const was = selectedTakeOf(state, id)?.renderedFrom;
  if (was === undefined) return [];
  const live = { ...shot, keyframe: (shot['keyframe'] as { asset: unknown }).asset };
  return [
    'prompt',
    'negativePrompt',
    'screenDirection',
    'route',
    'conditioning',
    'keyframe',
    'entities',
  ].filter((axis) => JSON.stringify(live[axis]) !== JSON.stringify(was[axis]));
}

function clip(id: string) {
  return {
    kind: 'clip',
    shotId: id,
    sourceRange: {
      startTime: { value: 0, rate: 24 },
      duration: { value: 96, rate: 24 },
    },
  };
}

function filmWithShots(count: number): Record<string, unknown> {
  let state = FILM_DEFINITION.initialState;
  state = act(state, 'bind_entity', { entityKey: 'ada', entity: ADA_V3 });
  for (let index = 0; index < count; index += 1) {
    const id = shotId(index);
    state = act(state, 'add_shot', { shot: shot({ name: `Shot ${index + 1}` }), clip: clip(id) });
  }
  return state;
}

describe('film fixture conformance', () => {
  it('passes the conformance gate — every template replays, including the shot-keyed ones', () => {
    const result = checkAppletConformance({
      definition: FILM_DEFINITION,
      source: FILM_VIEW_SOURCE,
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(
      result.warnings.filter((warning) => warning.code === 'sample_input_unsatisfiable'),
    ).toEqual([]);
    expect(new Set(result.warnings.map((warning) => warning.code))).toEqual(
      new Set(['missing_call_site']),
    );
  });

  it('is born with a video track and an audio track and nothing else', () => {
    expect(validateState(FILM_DEFINITION.initialState).errors).toEqual([]);
    const timeline = FILM_DEFINITION.initialState['timeline'] as {
      tracks: Array<{ kind: string; items: unknown[] }>;
    };
    expect(timeline.tracks.map((track) => track.kind)).toEqual(['video', 'audio']);
    expect(timeline.tracks.every((track) => track.items.length === 0)).toBe(true);
    expect(FILM_DEFINITION.initialState['shots']).toEqual({});
  });
});

describe('film actions produce the change they claim', () => {
  it('add_shot creates the shot, its sidecar and its clip', () => {
    const state = act(filmWithShots(0), 'add_shot', { shot: shot(), clip: clip(shotId(0)) });
    const shots = state['shots'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(shots)).toEqual([shotId(0)]);
    expect(shots[shotId(0)]?.['prompt']).toContain('rain-slicked yard');
    expect((state['shotAssets'] as Record<string, unknown>)[shotId(0)]).toEqual({
      receipts: null,
      qc: null,
    });
    const tracks = (state['timeline'] as { tracks: Array<{ items: unknown[] }> }).tracks;
    expect(tracks[0]?.items).toEqual([clip(shotId(0))]);
    expect(tracks[1]?.items).toEqual([]);
  });

  it('the shot edit a person asks for: shot 4 slower, its character swapped to Ada', () => {
    let state = filmWithShots(5);
    state = act(state, 'bind_entity', { entityKey: 'ben', entity: BEN_V1 });
    state = act(state, 'bind_shot_entity', { shotId: shotId(3), role: 'lead', entity: BEN_V1 });
    expect(
      (
        (state['shots'] as Record<string, Record<string, unknown>>)[shotId(3)]?.[
          'entities'
        ] as Record<string, unknown>
      )['lead'],
    ).toEqual(BEN_V1);

    state = act(state, 'set_timing', { shotId: shotId(3), durationSeconds: 4, speed: 0.5 });
    state = act(state, 'bind_shot_entity', { shotId: shotId(3), role: 'lead', entity: ADA_V3 });

    const shots = state['shots'] as Record<string, Record<string, unknown>>;
    const edited = shots[shotId(3)]!;
    expect(edited['speed']).toBe(0.5);
    expect((edited['entities'] as Record<string, unknown>)['lead']).toEqual(ADA_V3);
    // Only shot 4 moved: the neighbours are untouched and nothing was resent.
    expect(shots[shotId(2)]?.['speed']).toBe(1);
    expect((shots[shotId(4)]?.['entities'] as Record<string, unknown>)['lead']).toEqual(ADA_V3);
  });

  it('set_prompt rewrites one shot and leaves the rest of the document alone', () => {
    const before = filmWithShots(3);
    const after = act(before, 'set_prompt', {
      shotId: shotId(1),
      prompt: 'Close on Ada’s hands, water beading on the sleeve',
      negativePrompt: '',
      screenDirection: 'toward',
    });
    const shots = after['shots'] as Record<string, Record<string, unknown>>;
    expect(shots[shotId(1)]?.['prompt']).toBe('Close on Ada’s hands, water beading on the sleeve');
    expect(shots[shotId(0)]).toEqual((before['shots'] as Record<string, unknown>)[shotId(0)]);
    expect(after['timeline']).toEqual(before['timeline']);
  });

  it('select_take records the take and its provenance, and only on the shot named', () => {
    const chosen = take(shotId(0));
    const state = act(filmWithShots(2), 'select_take', { shotId: shotId(0), take: chosen });
    const shots = state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots[shotId(0)]?.['selectedTake']).toEqual(chosen);
    expect(shots[shotId(1)]?.['selectedTake']).toBeNull();
    expect(staleAxes(state, shotId(0))).toEqual([]);
  });

  it('take histories, receipts and QC reports enter state as pins, never as content', () => {
    const takes = pin('/film/shots/sh_0/takes.json', 7, 'tk');
    const receipts = pin('/film/shots/sh_0/receipts.json', 7, 'rc');
    const state = act(filmWithShots(1), 'attach_shot_documents', {
      shotId: shotId(0),
      takes,
      receipts,
      qc: null,
    });
    // The take history lands on the shot, where the agent can reach it; the
    // cost and QC pins land in the sidecar, which it never reads.
    expect(
      (state['shots'] as Record<string, Record<string, unknown>>)[shotId(0)]?.['takes'],
    ).toEqual(takes);
    expect((state['shotAssets'] as Record<string, unknown>)[shotId(0)]).toEqual({
      receipts,
      qc: null,
    });
    expect(
      validateInput('attach_shot_documents', {
        shotId: shotId(0),
        takes: [{ takeId: 'tk_1' }],
        receipts: null,
        qc: null,
      }).valid,
    ).toBe(false);
  });

  it('resolving a note removes it, so the map only ever holds what is still open', () => {
    const marker = {
      shotId: shotId(0),
      at: { value: 48, rate: 24 },
      comment: 'the cut lands a beat late here',
    };
    let state = act(filmWithShots(1), 'add_marker', { markerId: 'mk_abc123', marker });
    expect((state['markers'] as Record<string, unknown>)['mk_abc123']).toEqual(marker);
    state = act(state, 'resolve_marker', { markerId: 'mk_abc123' });
    expect(state['markers']).toEqual({});
    // Nothing to resolve twice — the note is gone, not flagged.
    expect(() =>
      applyAppletStatePatch(
        state,
        materializeAppletTemplatePatch(template('resolve_marker'), { markerId: 'mk_abc123' }),
      ),
    ).toThrow();
  });

  it('the audio track takes clips from the day the film is born', () => {
    const audio = {
      kind: 'audio',
      asset: pin('/film/audio/score.wav', 2, 'sc'),
      sourceRange: { startTime: { value: 0, rate: 48 }, duration: { value: 480, rate: 48 } },
      gainDb: -6,
    };
    const state = act(filmWithShots(1), 'add_timeline_item', { trackIndex: 1, item: audio });
    const tracks = (state['timeline'] as { tracks: Array<{ items: unknown[] }> }).tracks;
    expect(tracks[1]?.items).toEqual([audio]);
  });
});

describe('film bindings are immutable', () => {
  it('no declared action writes below a binding — a pin is replaced whole or not at all', () => {
    for (const declared of FILM_DEFINITION.actions) {
      if (declared.patch === 'actor_supplied') continue;
      for (const op of (declared.patch as AppletTemplatePatch).template) {
        const segments = op.pathTemplate ?? (op.path === undefined ? [] : [op.path]);
        const literals = segments.filter(
          (segment): segment is string => typeof segment === 'string',
        );
        expect(literals).not.toContain('pin');
        expect(literals).not.toContain('version');
        expect(literals).not.toContain('contentHash');
      }
    }
  });

  it('a binding that names a path without the version and hash is not a valid binding', () => {
    for (const partial of [
      { kind: 'character', name: 'Ada', pins: [{ path: '/film/entities/ada.md' }] },
      { kind: 'character', name: 'Ada', pins: [{ path: '/film/entities/ada.md', version: 3 }] },
      { kind: 'character', name: 'Ada', pins: [{ ...ADA_V3.pins[0], latest: true }] },
    ]) {
      expect(validateInput('bind_entity', { entityKey: 'ada', entity: partial }).valid).toBe(false);
    }
  });

  it('repinning the library never moves a shot already bound to a version', () => {
    let state = filmWithShots(2);
    state = act(state, 'bind_entity', { entityKey: 'ada', entity: ADA_V4 });
    expect((state['entities'] as Record<string, unknown>)['ada']).toEqual(ADA_V4);
    const shots = state['shots'] as Record<string, Record<string, unknown>>;
    for (const id of [shotId(0), shotId(1)]) {
      expect((shots[id]?.['entities'] as Record<string, unknown>)['lead']).toEqual(ADA_V3);
    }
  });

  it('a route that cannot combine frame conditioning with reference packs has no shape for it', () => {
    const frames = { mode: 'frames', endFrame: null };
    expect(
      validateInput('set_recipe', {
        shotId: shotId(0),
        route: { model: 'google-veo', quality: 'final' },
        conditioning: frames,
        keyframeRecipe: KEYFRAME_RECIPE,
      }).valid,
    ).toBe(true);
    expect(
      validateInput('set_recipe', {
        shotId: shotId(0),
        route: { model: 'google-veo', quality: 'final' },
        conditioning: { ...frames, roles: ['lead'] },
        keyframeRecipe: KEYFRAME_RECIPE,
      }).valid,
    ).toBe(false);
  });
});

describe('the sequence is edited by position, and the position is checked', () => {
  it('a reorder moves the clip named at that index and nothing else', () => {
    const reordered = act(filmWithShots(3), 'reorder_shot', {
      trackIndex: 0,
      fromIndex: 2,
      toIndex: 0,
      clip: clip(shotId(2)),
    });
    const tracks = (
      reordered['timeline'] as { tracks: Array<{ items: Array<{ shotId: string }> }> }
    ).tracks;
    expect(tracks[0]?.items.map((item) => item.shotId)).toEqual([shotId(2), shotId(0), shotId(1)]);
  });

  it('the reorder is refused unless the clip named is the clip at that position', () => {
    expect(() =>
      applyAppletStatePatch(
        filmWithShots(3),
        materializeAppletTemplatePatch(template('reorder_shot'), {
          trackIndex: 0,
          fromIndex: 2,
          toIndex: 0,
          clip: clip(shotId(1)),
        }),
      ),
    ).toThrow();
  });

  it('the guard says so in words when the position holds no clip at all', () => {
    const guard = action('trim_clip').guard!;
    const input = { shotId: shotId(0), trackIndex: 1, itemIndex: 0, sourceRange: {} };
    expect(evaluateAppletActionGuard({ guard, state: filmWithShots(1), input }).ok).toBe(false);
    expect(
      evaluateAppletActionGuard({
        guard,
        state: filmWithShots(1),
        input: { ...input, trackIndex: 0 },
      }),
    ).toEqual({ ok: true });
  });
});

/** 45 shots, each with a chosen take, its history pinned and its cost recorded. */
function filmInProduction(): Record<string, unknown> {
  let state = filmWithShots(45);
  for (let index = 0; index < 45; index += 1) {
    const id = shotId(index);
    state = act(state, 'select_take', {
      shotId: id,
      take: take(id, { note: 'the one where the light holds' }),
    });
    state = act(state, 'attach_shot_documents', {
      shotId: id,
      takes: pin(`/film/shots/${id}/takes.json`, 9, `k${index}`),
      receipts: pin(`/film/shots/${id}/receipts.json`, 9, `r${index}`),
      qc: pin(`/film/shots/${id}/qc.json`, 2, `q${index}`),
    });
  }
  for (let index = 0; index < 20; index += 1) {
    state = act(state, 'add_marker', {
      markerId: `mk_${String(index).padStart(6, '0')}`,
      marker: {
        shotId: shotId(index),
        at: { value: index * 96, rate: 24 },
        comment: 'the eyeline drifts left of camera across this pair of shots',
      },
    });
  }
  return act(state, 'set_grade', {
    grade: {
      look: 'warm sodium highlights, teal shadows, gentle halation',
      note: '',
      plate: GRADE_PLATE,
    },
  });
}

describe('a selected take carries what it was rendered against', () => {
  it('a take cannot claim a render the shot never asked for', () => {
    const state = filmWithShots(1);
    const lying = take(shotId(0), {
      renderedFrom: {
        screenDirection: 'toward',
        prompt: 'Close on the gate latch',
        negativePrompt: NEGATIVE_PROMPT,
        durationSeconds: 4,
        route: ROUTE,
        conditioning: CONDITIONING,
        keyframe: KEYFRAME_ASSET,
        entities: { lead: ADA_V3 },
      },
    });
    expect(validateInput('select_take', { shotId: shotId(0), take: lying }).valid).toBe(true);
    expect(() =>
      applyAppletStatePatch(
        state,
        materializeAppletTemplatePatch(template('select_take'), {
          shotId: shotId(0),
          take: lying,
        }),
      ),
    ).toThrow();
  });

  it('a prompt rewrite makes the chosen take stale, and says which axis moved', () => {
    let state = act(filmWithShots(2), 'select_take', {
      shotId: shotId(0),
      take: take(shotId(0)),
    });
    expect(staleAxes(state, shotId(0))).toEqual([]);

    state = act(state, 'set_prompt', {
      shotId: shotId(0),
      prompt: 'Close on Ada’s hands, water beading on the sleeve',
      negativePrompt: NEGATIVE_PROMPT,
      screenDirection: 'toward',
    });
    expect(staleAxes(state, shotId(0))).toEqual(['prompt']);
    // Only the edited shot moved.
    expect(staleAxes(state, shotId(1))).toEqual([]);

    // A take generated before the rewrite can no longer be recorded against it.
    expect(() =>
      applyAppletStatePatch(
        state,
        materializeAppletTemplatePatch(template('select_take'), {
          shotId: shotId(0),
          take: take(shotId(0), { takeId: 'tk_older' }),
        }),
      ),
    ).toThrow();
  });

  it('a repin makes the chosen take stale even though the prompt never changed', () => {
    let state = act(filmWithShots(1), 'select_take', {
      shotId: shotId(0),
      take: take(shotId(0)),
    });
    state = act(state, 'bind_entity', { entityKey: 'ada', entity: ADA_V4 });
    // The library moved; the shot did not, so neither did the take.
    expect(staleAxes(state, shotId(0))).toEqual([]);

    state = act(state, 'bind_shot_entity', { shotId: shotId(0), role: 'lead', entity: ADA_V4 });
    expect(staleAxes(state, shotId(0))).toEqual(['entities']);
    expect(selectedTakeOf(state, shotId(0))?.renderedFrom['entities']).toEqual({ lead: ADA_V3 });
  });

  it('a re-route restales the take — the cheap draft pass is upgraded by editing the shot', () => {
    let state = act(filmWithShots(1), 'select_take', {
      shotId: shotId(0),
      take: take(shotId(0)),
    });
    state = act(state, 'set_route', {
      shotId: shotId(0),
      route: { model: 'runware-kling', quality: 'final' },
    });
    const shots = state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots[shotId(0)]!['route']).toEqual({ model: 'runware-kling', quality: 'final' });
    expect(staleAxes(state, shotId(0))).toEqual(['route']);
  });

  it('authoring a reference-conditioned shot onto a blind route refuses at the input', () => {
    // The pairing that cost the first render pass four mid-run route hops:
    // reference conditioning animates the keyframe, and a route with no
    // reference input renders without the cast, billed in full. The rule
    // lives on the authoring inputs (add_shot, set_recipe); the state schema
    // cannot carry the disjunction until the conformance gate's path
    // admission honors one, so set_route remains the recorded residual.
    expect(
      validateInput('set_recipe', {
        shotId: shotId(0),
        route: { model: 'google-veo', quality: 'draft' },
        conditioning: { mode: 'reference', endFrame: null },
        keyframeRecipe: KEYFRAME_RECIPE,
      }).valid,
    ).toBe(false);
    expect(
      validateInput('add_shot', {
        shot: shot({ route: { model: 'google-veo', quality: 'draft' } }),
        clip: clip(shotId(0)),
      }).valid,
    ).toBe(false);
    // The same route carries a prompt-conditioned shot without complaint.
    const state = act(filmWithShots(1), 'set_recipe', {
      shotId: shotId(0),
      route: { model: 'google-veo', quality: 'draft' },
      conditioning: { mode: 'prompt' },
      keyframeRecipe: null,
    });
    const shots = state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots[shotId(0)]!['route']).toEqual({ model: 'google-veo', quality: 'draft' });
  });

  it('a direction change alone restales the take, and the axis names it', () => {
    let state = act(filmWithShots(1), 'select_take', {
      shotId: shotId(0),
      take: take(shotId(0)),
    });
    state = act(state, 'set_prompt', {
      shotId: shotId(0),
      prompt: PROMPT,
      negativePrompt: NEGATIVE_PROMPT,
      screenDirection: 'away',
    });
    expect(staleAxes(state, shotId(0))).toEqual(['screenDirection']);

    // A take rendered before the turn cannot be recorded as if it saw it.
    expect(() =>
      applyAppletStatePatch(
        state,
        materializeAppletTemplatePatch(template('select_take'), {
          shotId: shotId(0),
          take: take(shotId(0), { takeId: 'tk_older' }),
        }),
      ),
    ).toThrow();
  });
});

describe('the casting sheet', () => {
  const LINE = {
    kind: 'character',
    name: 'Ada',
    brief: 'Late twenties, rain shell over a courier bag, deliberate stride.',
  };

  it('drafts a line, revises it in place, and strikes it', () => {
    let state = act(filmWithShots(0), 'draft_casting', { entityKey: 'ada', casting: LINE });
    expect(state['casting']).toEqual({ ada: LINE });

    const revised = { ...LINE, brief: 'Late twenties, yellow rain shell, hurried stride.' };
    state = act(state, 'draft_casting', { entityKey: 'ada', casting: revised });
    expect(state['casting']).toEqual({ ada: revised });

    state = act(state, 'strike_casting', { entityKey: 'ada' });
    expect(state['casting']).toEqual({});
  });

  it('a line needs its brief — a cast entity with no description is not cast', () => {
    expect(
      validateInput('draft_casting', {
        entityKey: 'ada',
        casting: { kind: 'character', name: 'Ada' },
      }).valid,
    ).toBe(false);
  });
});

describe('scenes are a continuity claim', () => {
  const scene = (index: number) => ({
    sceneId: `sc_${String(index).padStart(6, '0')}`,
    scene: { name: `Scene ${index + 1}`, note: '' },
  });

  it('add_scene lands the scene; set_scene stands a shot in it, and null takes it out', () => {
    let state = act(filmWithShots(1), 'add_scene', scene(0));
    expect(state['scenes']).toEqual({ sc_000000: { name: 'Scene 1', note: '' } });

    state = act(state, 'set_scene', { shotId: shotId(0), sceneId: 'sc_000000' });
    const shots = state['shots'] as Record<string, Record<string, unknown>>;
    expect(shots[shotId(0)]!['sceneId']).toBe('sc_000000');

    state = act(state, 'set_scene', { shotId: shotId(0), sceneId: null });
    expect((state['shots'] as Record<string, Record<string, unknown>>)[shotId(0)]!['sceneId']).toBe(
      null,
    );
  });

  it('fills to the ceiling and refuses the next scene by name', () => {
    let state = filmWithShots(1);
    for (let index = 0; index < 45; index += 1) state = act(state, 'add_scene', scene(index));
    expect(Object.keys(state['scenes'] as object)).toHaveLength(45);

    const over = applyAppletStatePatch(
      state,
      materializeAppletTemplatePatch(template('add_scene'), scene(45)),
    );
    expect(validateState(over).errors).toEqual(['/scenes: must NOT have more than 45 properties']);
  });
});

describe('the open-note budget', () => {
  const note = (index: number) => ({
    markerId: `mk_${String(index).padStart(6, '0')}`,
    marker: { shotId: null, at: { value: index, rate: 24 }, comment: 'the grade goes cold here' },
  });

  it('fills to the ceiling, refuses the next note by name, and takes one the moment one closes', () => {
    let state = filmWithShots(1);
    for (let index = 0; index < 90; index += 1) state = act(state, 'add_marker', note(index));
    expect(Object.keys(state['markers'] as object)).toHaveLength(90);

    const over = applyAppletStatePatch(
      state,
      materializeAppletTemplatePatch(template('add_marker'), note(90)),
    );
    expect(validateState(over).errors).toEqual(['/markers: must NOT have more than 90 properties']);

    const closed = act(state, 'resolve_marker', { markerId: 'mk_000000' });
    expect(Object.keys(closed['markers'] as object)).toHaveLength(89);
    expect(Object.keys(act(closed, 'add_marker', note(90))['markers'] as object)).toHaveLength(90);
  });
});

describe('the attention line', () => {
  const attention = (state: Record<string, unknown>) =>
    projectAppletAttention(state, FILM_DEFINITION.attentionProjection);

  it('says what the room named and never what follows from it', () => {
    expect(attention(FILM_DEFINITION.initialState)).toEqual({ title: 'Untitled film' });

    const named = act(filmInProduction(), 'set_project', {
      title: 'Cold Open',
      logline: 'A woman crosses a yard',
      aspectRatio: '2.39:1',
      fps: 24,
    });
    expect(attention(named)).toEqual({ title: 'Cold Open' });

    // No pointer resolves to a consequence, so no reading can outlive its cause.
    for (const line of [attention(FILM_DEFINITION.initialState), attention(named)]) {
      expect(line?.status).toBeUndefined();
      expect(line?.waitingOn).toBeUndefined();
    }
  });
});

describe('film state at production scale', () => {
  it('45 shots, each the survivor of ten generations, stay well inside the state cap', () => {
    const state = filmInProduction();

    expect(jsonUtf8Bytes(state)).toBeLessThan(APPLET_STATE_MAX_BYTES / 2);
    expect(validateState(state).errors).toEqual([]);

    // The sidecar is two pins whatever the shot cost to make, so state size is
    // independent of how many generations it took to get one usable take.
    const sidecar = (state['shotAssets'] as Record<string, Record<string, unknown>>)[shotId(0)]!;
    expect(Object.keys(sidecar).sort()).toEqual(['qc', 'receipts']);
    expect(jsonUtf8Bytes(sidecar)).toBeLessThan(300);
  });

  it('every cap in the schema at once still lands under the byte cap', () => {
    let state = filmWithShots(90);
    for (let index = 0; index < 45; index += 1) {
      state = act(state, 'add_scene', {
        sceneId: `sc_${String(index).padStart(6, '0')}`,
        scene: {
          name: `The yard at dusk, pass ${index + 1}`.padEnd(120, '.'),
          note: 'Continuous time across every cut: Ada keeps crossing left to right, the rain holds, the sodium light never warms.'.padEnd(
            600,
            '.',
          ),
        },
      });
    }
    for (let index = 0; index < 90; index += 1) {
      const id = shotId(index);
      state = act(state, 'set_scene', {
        shotId: id,
        sceneId: `sc_${String(index % 45).padStart(6, '0')}`,
      });
      state = act(state, 'select_take', { shotId: id, take: take(id) });
    }
    for (let index = 0; index < 90; index += 1) {
      state = act(state, 'add_marker', {
        markerId: `mk_${String(index).padStart(6, '0')}`,
        marker: {
          shotId: shotId(index),
          at: { value: index * 96, rate: 24 },
          comment:
            'the eyeline drifts left of camera across this pair of shots and the grade cools',
        },
      });
    }
    expect(validateState(state).errors).toEqual([]);
    expect(jsonUtf8Bytes(state)).toBeLessThan(APPLET_STATE_MAX_BYTES);
  });

  it('a review turn reads the take history and the provenance; the cost pins stay out', () => {
    const state = filmInProduction();
    const projected = projectAppletState(state, FILM_DEFINITION.agentProjection);
    expect(Object.keys(projected).sort()).toEqual([
      'casting',
      'entities',
      'grade',
      'markers',
      'project',
      'scenes',
      'shots',
      'timeline',
    ]);
    expect(projected['shotAssets']).toBeUndefined();

    const projectedShot = (projected['shots'] as Record<string, Record<string, unknown>>)[
      shotId(0)
    ]!;
    expect(projectedShot['takes']).toEqual(pin(`/film/shots/${shotId(0)}/takes.json`, 9, 'k0'));
    expect(projectedShot['selectedTake']).toHaveProperty('renderedFrom');
    expect(jsonUtf8Bytes(projected)).toBeLessThan(jsonUtf8Bytes(state));
  });
});
