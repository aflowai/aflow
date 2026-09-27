/**
 * The curated film applet: the definition is validated at module load (an
 * invalid fixture fails the import), the contract carries the design — a pin
 * without its version is unwritable, conditioning modes are disjoint, a take
 * says what it was rendered against, and where the film stands is read off the
 * document rather than maintained as a status — and the store listing wraps
 * the fixture identity-coherently.
 */
import { describe, it, expect } from 'vitest';
import { AppletDefinitionSchema, type AppletTemplatePatch } from '@aflow/schemas';
import { checkAppletConformance, extractAppletActCallSites } from '@aflow/applet-runtime';
import { FILM_DEFINITION, FILM_VIEW_SOURCE } from '../appletFixtures/film.js';
import { getCatalogEntry, listCatalog } from '../storeCatalog/index.js';

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

function stateMember(name: string): Record<string, unknown> {
  const properties = (FILM_DEFINITION.stateSchema as { properties: Record<string, unknown> })
    .properties;
  return properties[name] as Record<string, unknown>;
}

function stateDef(name: string): Record<string, unknown> {
  const defs = (FILM_DEFINITION.stateSchema as { $defs: Record<string, unknown> }).$defs;
  return defs[name] as Record<string, unknown>;
}

function properties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return schema['properties'] as Record<string, Record<string, unknown>>;
}

/** Every literal path segment any declared template writes through. */
function writtenSegments(): string[] {
  return FILM_DEFINITION.actions.flatMap((candidate) => {
    if (candidate.patch === 'actor_supplied') return [];
    return (candidate.patch as AppletTemplatePatch).template.flatMap((op) => {
      const segments = op.pathTemplate ?? (op.path === undefined ? [] : op.path.split('/'));
      return segments.filter((segment): segment is string => typeof segment === 'string');
    });
  });
}

describe('film applet definition', () => {
  it('parses at module load and re-parses clean', () => {
    expect(FILM_DEFINITION.appletKey).toBe('film');
    expect(AppletDefinitionSchema.parse(FILM_DEFINITION)).toEqual(FILM_DEFINITION);
  });

  it('is born empty, with a video track and an audio track already present', () => {
    expect(FILM_DEFINITION.initialState['project']).toEqual({
      title: 'Untitled film',
      logline: '',
      aspectRatio: '16:9',
      fps: 24,
    });
    expect(FILM_DEFINITION.initialState['shots']).toEqual({});
    expect(FILM_DEFINITION.initialState['entities']).toEqual({});
    expect(FILM_DEFINITION.initialState['timeline']).toEqual({
      tracks: [
        { kind: 'video', name: 'V1', items: [] },
        { kind: 'audio', name: 'A1', items: [] },
      ],
    });
  });

  it('a reference names an exact version and hash — there is no shape that omits them', () => {
    const pin = (FILM_DEFINITION.stateSchema as { $defs: Record<string, Record<string, unknown>> })
      .$defs['pin']!;
    expect(pin['required']).toEqual(['path', 'version', 'contentHash']);
    expect(pin['additionalProperties']).toBe(false);
    expect((pin['properties'] as Record<string, Record<string, unknown>>)['version']).toMatchObject(
      {
        type: 'integer',
        minimum: 1,
      },
    );
  });

  it('conditioning modes are disjoint and closed — frames and reference packs cannot combine', () => {
    const branches = (stateDef('conditioning')['oneOf'] ?? []) as Array<Record<string, unknown>>;
    expect(
      branches.map(
        (branch) =>
          (
            (branch['properties'] as Record<string, Record<string, unknown>>)['mode'] as {
              const: string;
            }
          ).const,
      ),
    ).toEqual(['prompt', 'reference', 'frames', 'extend']);
    for (const branch of branches) {
      expect(branch['additionalProperties']).toBe(false);
      const properties = Object.keys(branch['properties'] as Record<string, unknown>);
      expect(branch['required']).toEqual(properties);
    }
  });

  it('growing collections carry their own ceiling, so a runaway names a field before it hits bytes', () => {
    expect(stateMember('shots')['maxProperties']).toBe(90);
    expect(stateMember('shotAssets')['maxProperties']).toBe(90);
    expect(stateMember('entities')['maxProperties']).toBe(60);
  });

  it('markers hold open notes only, so the map is a working set and not a ledger', () => {
    expect(
      Object.keys(properties(stateMember('markers')['additionalProperties'] as never)),
    ).toEqual(['shotId', 'at', 'comment']);
    expect(template('resolve_marker')).toEqual([
      { op: 'remove', pathTemplate: ['/state/markers', { from: '/input/markerId' }] },
    ]);
    expect(action('resolve_marker').inputSchema['properties']).not.toHaveProperty('status');
    // One unresolved note per shot is already a backlog, so the ceilings match.
    expect(stateMember('markers')['maxProperties']).toBe(stateMember('shots')['maxProperties']);
  });

  it('a take says what it was rendered against, on every axis that decides the render', () => {
    const provenance = properties(stateDef('take'))['renderedFrom']!;
    expect(stateDef('take')['required']).toEqual(['takeId', 'asset', 'note', 'renderedFrom']);
    expect(provenance['required']).toEqual([
      'prompt',
      'negativePrompt',
      'screenDirection',
      'durationSeconds',
      'route',
      'conditioning',
      'keyframe',
      'entities',
    ]);
    expect(provenance['additionalProperties']).toBe(false);
    // Every recorded axis is the same shape as the shot field it mirrors, so
    // staleness is a comparison and never a reinterpretation.
    const shot = properties(stateMember('shots')['additionalProperties'] as never);
    for (const axis of [
      'prompt',
      'negativePrompt',
      'screenDirection',
      'durationSeconds',
      'route',
      'conditioning',
      'entities',
    ] as const) {
      expect(properties(provenance)[axis]).toEqual(shot[axis]);
    }
    // The keyframe is the exception, and deliberately: a take read the frame's
    // bytes, not the recipe that made them, so it records the asset while the
    // shot records the whole render. Mirroring the record here would carry the
    // recipe and the bindings a third and fourth time per shot, and 90 shots of
    // that does not fit the state cap.
    expect(properties(provenance)['keyframe']).toEqual({
      oneOf: [{ type: 'null' }, { $ref: '#/$defs/pin' }],
    });
  });

  it('select_take asserts the provenance against the live shot rather than trusting it', () => {
    const tested = template('select_take')
      .filter((op) => op.op === 'test')
      .map((op) => ({ field: op.pathTemplate?.[2], from: op.valueFrom }));
    expect(tested).toEqual([
      { field: 'prompt', from: '/input/take/renderedFrom/prompt' },
      { field: 'negativePrompt', from: '/input/take/renderedFrom/negativePrompt' },
      { field: 'screenDirection', from: '/input/take/renderedFrom/screenDirection' },
      { field: 'durationSeconds', from: '/input/take/renderedFrom/durationSeconds' },
      { field: 'route', from: '/input/take/renderedFrom/route' },
      { field: 'conditioning', from: '/input/take/renderedFrom/conditioning' },
      { field: 'keyframe', from: '/input/take/renderedFrom/keyframe' },
      { field: 'entities', from: '/input/take/renderedFrom/entities' },
    ]);
  });

  it('no action is actor-supplied — an input schema that binds is one the platform enforces', () => {
    const actorSupplied = FILM_DEFINITION.actions
      .filter((candidate) => candidate.patch === 'actor_supplied')
      .map((candidate) => candidate.name);
    expect(actorSupplied).toEqual([]);
  });

  it('an index-addressed edit names what sits at the index, and the platform checks it', () => {
    const named: Array<[string, string]> = [
      ['remove_shot', '/input/shotId'],
      ['trim_clip', '/input/shotId'],
      ['reorder_shot', '/input/clip'],
      ['remove_timeline_item', '/input/kind'],
    ];
    for (const [name, valueFrom] of named) {
      const first = template(name)[0];
      expect(first?.op).toBe('test');
      expect(first?.valueFrom).toBe(valueFrom);
      expect(first?.pathTemplate?.[0]).toBe('/state/timeline/tracks');
    }
  });

  it('a clip-addressed edit says so in words when the position holds something else', () => {
    for (const name of ['reorder_shot', 'remove_shot', 'trim_clip']) {
      const guard = action(name).guard;
      expect(guard?.equals).toBe('clip');
      expect(guard?.assert.at(-1)).toBe('kind');
      expect(guard?.onUnverifiable).toBe('reject');
      expect(guard?.message).toMatch(/read the timeline/);
    }
  });

  it('the only guards left are the ones that protect what renders', () => {
    expect(
      FILM_DEFINITION.actions
        .filter((candidate) => candidate.guard !== undefined)
        .map((c) => c.name),
    ).toEqual(['reorder_shot', 'remove_shot', 'trim_clip']);
  });

  it('a shot, its clip and its sidecar leave in one patch', () => {
    const removed = template('remove_shot')
      .filter((op) => op.op === 'remove')
      .map((op) => op.pathTemplate?.[0]);
    expect(removed).toEqual(['/state/timeline/tracks', '/state/shots', '/state/shotAssets']);
  });

  it('where a shot stands is read off the document — there is no status to maintain', () => {
    const shot = properties(stateMember('shots')['additionalProperties'] as never);
    expect(Object.keys(shot)).toEqual([
      'name',
      'prompt',
      'negativePrompt',
      'screenDirection',
      'sceneId',
      'durationSeconds',
      'speed',
      'route',
      'conditioning',
      'keyframeRecipe',
      'keyframe',
      'entities',
      'selectedTake',
      'takes',
      'note',
    ]);
    // A status field is a second account of what selectedTake and renderedFrom
    // already say, and the two drift; nothing anywhere writes one.
    expect(writtenSegments()).not.toContain('status');
  });

  it('the film has no phase and no assembly to keep a revision of', () => {
    expect(Object.keys(properties(stateMember('project')))).toEqual([
      'title',
      'logline',
      'aspectRatio',
      'fps',
    ]);
    expect(FILM_DEFINITION.initialState).not.toHaveProperty('cut');
    expect(writtenSegments()).not.toContain('phase');
    expect(writtenSegments().filter((segment) => segment.includes('/cut'))).toEqual([]);
  });

  it('a clip reaches a track only with the shot it plays', () => {
    const placeable = properties(action('add_timeline_item').inputSchema)['item']?.[
      'oneOf'
    ] as Array<Record<string, unknown>>;
    const kinds = placeable.map(
      (branch) => (properties(branch)['kind'] as { const: string }).const,
    );
    expect(kinds).toEqual(['audio', 'gap', 'transition']);
    expect(properties(action('remove_timeline_item').inputSchema)['kind']?.['enum']).toEqual([
      'audio',
      'gap',
      'transition',
    ]);
  });

  it('everything a review turn reads is projected; only the cost and QC pins are not', () => {
    expect(FILM_DEFINITION.agentProjection).toEqual([
      '/project',
      '/grade',
      '/entities',
      '/casting',
      '/scenes',
      '/shots',
      '/timeline',
      '/markers',
    ]);
    expect(FILM_DEFINITION.agentProjection).not.toContain('/shotAssets');
    // The take history moved onto the projected shot; what stayed behind is
    // the audit sidecar, which no review turn reads.
    expect(properties(stateMember('shots')['additionalProperties'] as never)).toHaveProperty(
      'takes',
    );
    expect(
      Object.keys(properties(stateMember('shotAssets')['additionalProperties'] as never)),
    ).toEqual(['receipts', 'qc']);
    expect(template('attach_shot_documents').map((op) => op.pathTemplate?.[0])).toEqual([
      '/state/shots',
      '/state/shotAssets',
      '/state/shotAssets',
    ]);
  });

  it('the attention surface names no consequence, so it has nothing to be stale about', () => {
    expect(FILM_DEFINITION.attentionProjection).toEqual({ title: '/project/title' });
    expect(FILM_DEFINITION.situationProjection).toEqual(['/project/logline', '/grade/look']);
  });

  // A sentence for the agent is typed in the chat, so no action here carries
  // one and none of them wakes it. What a marker carries instead is a shot and
  // a timecode — the thing a sentence in the chat cannot address. What stays
  // gone is the status machinery: nothing declares a project finished, because
  // the platform archives an instance and a film does not need to say so.
  it('nothing here duplicates the chat, and nothing declares the project over', () => {
    for (const declared of FILM_DEFINITION.actions) {
      const fields = Object.keys(
        (declared.inputSchema['properties'] ?? {}) as Record<string, unknown>,
      );
      expect(fields).not.toContain('ask');
      expect(fields).not.toContain('message');
    }
    expect(FILM_DEFINITION.actions.filter((candidate) => candidate.wakes)).toEqual([]);
    expect(FILM_DEFINITION.actions.filter((candidate) => candidate.ends)).toEqual([]);
    expect(
      FILM_DEFINITION.actions.filter((candidate) => candidate.notable).map((c) => c.name),
    ).toEqual(['add_marker']);
  });

  it('the roles are the people around a cut', () => {
    expect(FILM_DEFINITION.roles?.map((role) => role.id)).toEqual([
      'director',
      'editor',
      'reviewer',
    ]);
  });
});

describe('curated film store listing', () => {
  it('is a published applet entry wrapping the fixture', () => {
    const entry = getCatalogEntry('film');
    expect(entry).not.toBeNull();
    if (entry === null || entry.kind !== 'applet') {
      throw new Error(`expected applet entry, got ${entry?.kind ?? 'null'}`);
    }
    expect(entry.status).toBe('published');
    expect(entry.honestyLabel).toBe('curated');
    expect(entry.payload.appletDefinition).toEqual(FILM_DEFINITION);
    expect(entry.payload.viewSource).toBe(FILM_VIEW_SOURCE);
    expect(entry.payload.artifactKind).toBe('applet');
    expect(entry.payload.libraries ?? []).toEqual([]);
  });

  it('surfaces through kind-filtered browse', () => {
    expect(listCatalog({ kind: 'applet' }).map((entry) => entry.catalogId)).toContain('film');
  });
});

/**
 * The install path runs this gate, and a view that fails it cannot be installed
 * at all. It is asserted here, beside the fixture, because the same check living
 * only in another package is one a scoped test run drops — which is how a view
 * whose every call site had gone dynamic reached an install attempt.
 */
describe('film view conformance', () => {
  it('passes the gate the install path runs', () => {
    const result = checkAppletConformance({
      definition: FILM_DEFINITION,
      source: FILM_VIEW_SOURCE,
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('names its actions literally, so the wiring is checkable at all', () => {
    const sites = extractAppletActCallSites(FILM_VIEW_SOURCE);
    const literal = sites.filter((site) => site.name !== null).map((site) => site.name);

    // A helper one hop from the bridge keeps these visible; a helper forwarding
    // to another helper hides every one of them and the applet stops installing.
    expect(literal.length).toBeGreaterThan(0);
    for (const name of literal) {
      expect(FILM_DEFINITION.actions.map((action) => action.name)).toContain(name);
    }
  });
});
