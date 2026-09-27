/**
 * The shapes the film applet's state and action schemas are built from.
 *
 * Separated from the definition because the two change for different reasons —
 * a shape moves when what a film records changes, the definition moves when
 * what the room can do changes — and together they outgrow the file-size bound.
 */
import { MEDIA_ROUTE_CAPABILITIES } from '@aflow/schemas';

export type JsonSchema = Record<string, unknown>;

/**
 * The mandatory prefix on a minted id is load-bearing twice over. `add`
 * silently clobbers an existing key and nothing can assert absence, so a
 * colliding id destroys a shot; and a template that writes INTO a
 * dynamically-keyed member replays against an empty map, which only passes the
 * conformance gate because the prefix makes the synthesized sample invalid.
 */
export const SHOT_ID_PATTERN = '^sh_[0-9a-z]{8,24}$';
export const MARKER_ID_PATTERN = '^mk_[0-9a-z]{6,20}$';
export const SCENE_ID_PATTERN = '^sc_[0-9a-z]{6,20}$';

export const SHOT_CAP = 90;

/**
 * A marker in state is an open note — resolving one removes it — so this is a
 * working set, not a ledger, and its ceiling is the shot ceiling: a review
 * that leaves more than one unresolved note per shot is a backlog, not a pass.
 */
export const OPEN_NOTE_CAP = SHOT_CAP;

/**
 * Finished work runs 2.5–5s a shot, so a film at the shot ceiling is a few
 * minutes long — more scenes than half its shots is not a film, it is a shot
 * list wearing scene ids.
 */
export const SCENE_CAP = SHOT_CAP / 2;

export const ENTITY_KEY_PATTERN = '^[a-z][a-z0-9_]{1,31}$';
const ROLE_PATTERN = '^[a-z][a-z0-9_]{1,23}$';
const VIDEO_ROUTE_KEYS = MEDIA_ROUTE_CAPABILITIES.filter(
  (capability) => capability.medium === 'video',
).map((capability) => capability.routeKey);
/**
 * The video routes that read references while animating a frame — the only
 * routes a reference-conditioned shot can render through at all. Derived from
 * the same measured capabilities as the route enum: a route with an empty
 * reference map or no frame input drops one half of what the shot asks for,
 * bills in full, and nothing downstream can tell the clip from one that saw
 * its cast.
 */
const REFERENCE_VIDEO_ROUTE_KEYS = MEDIA_ROUTE_CAPABILITIES.filter(
  (capability) =>
    capability.medium === 'video' &&
    Object.keys(capability.references).length > 0 &&
    capability.frames !== undefined,
).map((capability) => capability.routeKey);

/**
 * Only the image routes that read references. A keyframe is the render the
 * film's plates reach, so a route that reads none of them produces a still
 * holding nothing of the world it was supposed to inherit — and nothing
 * downstream can tell that still from one that did.
 */
const IMAGE_ROUTE_KEYS = MEDIA_ROUTE_CAPABILITIES.filter(
  (capability) => capability.medium === 'image' && Object.keys(capability.references).length > 0,
).map((capability) => capability.routeKey);
const MEMORY_PATH_PATTERN = '^/[A-Za-z0-9._/-]{1,500}$';
/**
 * The most angles any wired route reads of one identity. Derived so that wiring
 * a more capable route widens what an entity may hold, which no state already
 * written can be invalidated by.
 */
const MAX_ENTITY_PINS = Math.max(
  1,
  ...MEDIA_ROUTE_CAPABILITIES.filter(
    (capability) => capability.medium === 'video' && capability.referenceEntities !== undefined,
  ).map((capability) => capability.referenceEntities?.maxImagesPerEntity ?? 1),
);

export const SHOT_ID: JsonSchema = {
  type: 'string',
  pattern: SHOT_ID_PATTERN,
  minLength: 11,
  maxLength: 27,
  description: "Shot id — 'sh_' plus at least eight random lowercase alphanumerics",
};

export const MARKER_ID: JsonSchema = {
  type: 'string',
  pattern: MARKER_ID_PATTERN,
  minLength: 9,
  maxLength: 23,
  description: "Marker id — 'mk_' plus at least six random lowercase alphanumerics",
};

export const ROLE: JsonSchema = {
  type: 'string',
  pattern: ROLE_PATTERN,
  minLength: 2,
  maxLength: 24,
  description: "The part this entity plays in the shot, e.g. 'lead', 'kitchen', 'hero_mug'",
};

/**
 * The immutable reference: a Memory path alone proves only that this JSON did
 * not change. `version` and `contentHash` are required and there is no shape
 * that omits them, so a binding cannot name a document without naming the
 * exact bytes it was bound to.
 */
const PIN: JsonSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      pattern: MEMORY_PATH_PATTERN,
      minLength: 2,
      maxLength: 512,
      description: 'Memory document path',
    },
    version: {
      type: 'integer',
      minimum: 1,
      description: 'The exact version read back — a pinned read never falls back to current',
    },
    contentHash: {
      type: 'string',
      minLength: 8,
      maxLength: 128,
      description:
        'stat.contentHash at that version — pass it as expectedContentHash so a changed document ' +
        'fails the read instead of returning different bytes',
    },
  },
  required: ['path', 'version', 'contentHash'],
  additionalProperties: false,
};

const RATIONAL_TIME: JsonSchema = {
  type: 'object',
  properties: {
    value: { type: 'number', minimum: 0, description: 'Frames, at rate' },
    rate: { type: 'number', exclusiveMinimum: 0, maximum: 240, description: 'Frames per second' },
  },
  required: ['value', 'rate'],
  additionalProperties: false,
};

/**
 * Every shared shape is referenced, never inlined: a take carries the shot it
 * was rendered from, so the same conditioning and binding shapes appear four
 * levels further down than they used to, and inlining them puts the document
 * past the schema depth bound.
 */
export const REF = {
  pin: { $ref: '#/$defs/pin' } satisfies JsonSchema,
  rationalTime: { $ref: '#/$defs/rationalTime' } satisfies JsonSchema,
  timeRange: { $ref: '#/$defs/timeRange' } satisfies JsonSchema,
  entityBinding: { $ref: '#/$defs/entityBinding' } satisfies JsonSchema,
  shotEntities: { $ref: '#/$defs/shotEntities' } satisfies JsonSchema,
  route: { $ref: '#/$defs/route' } satisfies JsonSchema,
  keyframeRecipe: { $ref: '#/$defs/keyframeRecipe' } satisfies JsonSchema,
  keyframe: { $ref: '#/$defs/keyframe' } satisfies JsonSchema,
  conditioning: { $ref: '#/$defs/conditioning' } satisfies JsonSchema,
  take: { $ref: '#/$defs/take' } satisfies JsonSchema,
};

const TIME_RANGE: JsonSchema = {
  type: 'object',
  properties: { startTime: REF.rationalTime, duration: REF.rationalTime },
  required: ['startTime', 'duration'],
  additionalProperties: false,
};

export const NULLABLE_PIN: JsonSchema = { oneOf: [{ type: 'null' }, REF.pin] };

const SHOT_KEYFRAME: JsonSchema = {
  ...REF.keyframe,
  description:
    'The still this shot animates, and what its render read. A shot whose keyframe asset is null ' +
    'has not rendered one yet and cannot be animated. A keyframe whose renderedFrom differs from ' +
    'the shot as it now stands is one the shot has edited past, and editing back makes it ' +
    'current again at no cost — which is why an edited recipe leaves it in place rather than ' +
    'discarding it',
};

/**
 * One line of the casting sheet: an entity the film needs, in words, before
 * the library holds its plate. The key it is drafted under is the key the
 * world pass binds the rendered plate to, so the concept the room approved
 * and the library that answers it stay one namespace. The brief is the
 * canonical description every render of this entity is judged against.
 */
export const CASTING_ENTRY: JsonSchema = {
  type: 'object',
  properties: {
    kind: {
      enum: ['character', 'set', 'prop', 'wardrobe', 'style'],
      description: 'What this entity is — the same vocabulary the library binds under',
    },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    brief: {
      type: 'string',
      minLength: 1,
      maxLength: 800,
      description:
        'The entity in words — appearance, wardrobe, age, mood, whatever every render of it ' +
        'must agree on. The plate is rendered from this, and drift is judged against it',
    },
  },
  required: ['kind', 'name', 'brief'],
  additionalProperties: false,
};

const ENTITY_BINDING: JsonSchema = {
  type: 'object',
  properties: {
    kind: {
      enum: ['character', 'set', 'prop', 'wardrobe', 'style'],
      description:
        'What this entity is. A route reads two kinds of reference and no more: a `character` ' +
        'binding conditions the keyframe as a character and rides on to the video render as a ' +
        'named identity, and every other kind conditions the keyframe as a style reference and ' +
        'goes no further. The film’s own vocabulary is the finer one — a set and a wardrobe are ' +
        'the same thing to a route and nothing alike to the room',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description:
        'What this entity is called — and the word a conditioned shot’s prompt has to use for ' +
        'it, because the route is told the name and reads the prompt for it. A prompt that names ' +
        'the character some other way renders without them',
    },
    pins: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_ENTITY_PINS,
      items: REF.pin,
      description:
        'The images this entity is recognised from, the frontal view first and further angles ' +
        'after it. One image is a weaker likeness than several, and a route reads them as one ' +
        'identity rather than as separate references',
    },
  },
  required: ['kind', 'name', 'pins'],
  additionalProperties: false,
  description: 'A reference pack pinned to exact versions — rebinding writes a whole new binding',
};

const ROUTE: JsonSchema = {
  type: 'object',
  properties: {
    model: {
      // Derived from the routes the platform can actually render with. A shot
      // naming anything else records a model no take was rendered by, and
      // `route` is one of the axes a take's staleness is measured on — so the
      // drift would be read against a render that never happened.
      enum: VIDEO_ROUTE_KEYS,
      description: 'The route this shot renders through',
    },
    quality: {
      enum: ['draft', 'final'],
      description: 'draft is the cheap proxy pass, final is the deliverable pass',
    },
  },
  required: ['model', 'quality'],
  additionalProperties: false,
};

/**
 * conditioning.mode = reference ⇒ route.model reads references while
 * animating. Stated as a disjunction because the applet keyword set carries
 * no if/then. The route branch comes first and carries the WHOLE route shape,
 * narrowed off the real one: the conformance gate's sample synthesizer
 * satisfies the first branch it sees by shallow member replacement, so a
 * branch that only narrowed `model` would replace the $ref'd route with a
 * fragment and synthesize an empty object.
 */
export const ROUTE_READS_THE_CONDITIONING: JsonSchema = {
  anyOf: [
    {
      properties: {
        route: {
          ...ROUTE,
          properties: {
            ...(ROUTE['properties'] as Record<string, JsonSchema>),
            model: {
              ...(ROUTE['properties'] as Record<string, JsonSchema>)['model'],
              enum: [...REFERENCE_VIDEO_ROUTE_KEYS],
            },
          },
        },
      },
    },
    {
      properties: { conditioning: { properties: { mode: { enum: ['prompt', 'frames'] } } } },
    },
  ],
  description:
    'A shot conditioning on references animates its keyframe, so its route must read ' +
    'references while animating a frame — a route that cannot renders without the cast, ' +
    'billed in full',
};

/**
 * Conditioning is a choice, not a bag: the branches are disjoint and closed, so
 * a shot states one way of being generated and a reader never has to work out
 * which parts of a combination applied.
 *
 * `reference` carries frames of its own rather than excluding them. A route
 * that holds a character does so while animating a starting frame, so keeping
 * the two apart would leave the only wired way to hold a character across shots
 * with no shape to be written in.
 */
const CONDITIONING: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { mode: { const: 'prompt' } },
      required: ['mode'],
      additionalProperties: false,
      description:
        'The prompt alone conditions the shot — nothing else reaches the render. A shot that ' +
        'binds entities under this mode renders without them, billed in full and missing the ' +
        'person; a shot with bindings wants reference conditioning',
    },
    {
      type: 'object',
      properties: {
        mode: { const: 'reference' },
        endFrame: NULLABLE_PIN,
      },
      required: ['mode', 'endFrame'],
      additionalProperties: false,
      description:
        'The entities bound on this shot condition it, and the prompt calls each one by the name ' +
        'its binding carries. The bindings are the list — a second list of role names would be a ' +
        'place for a dropped role to survive, so there is not one. Holding a character is ' +
        'something a render does while animating a frame, so this mode animates the shot’s ' +
        'keyframe: until one is rendered the shot cannot be generated at all, because the only ' +
        'way left carries no references and would come back billed in full and without the ' +
        'character',
    },
    {
      type: 'object',
      properties: {
        mode: { const: 'frames' },
        endFrame: NULLABLE_PIN,
      },
      required: ['mode', 'endFrame'],
      additionalProperties: false,
      description:
        'The shot’s keyframe, optionally a last frame, and the bound entities do not reach the ' +
        'video render — a shot that should hold its characters through the motion uses reference ' +
        'conditioning instead. The keyframe render still conditions on whatever is bound',
    },
    {
      type: 'object',
      properties: { mode: { const: 'extend' }, parent: REF.pin },
      required: ['mode', 'parent'],
      additionalProperties: false,
      description: 'Provider-native continuation of a clip that route generated',
    },
  ],
};

export const PROMPT: JsonSchema = { type: 'string', minLength: 1, maxLength: 1200 };
export const DURATION_SECONDS: JsonSchema = {
  type: 'number',
  exclusiveMinimum: 0,
  maximum: 30,
  description:
    'Generated length. Finished shots run 3 to 5 seconds, and routes render a whole number of ' +
    'them — a fractional length is refused rather than rounded',
};
export const NEGATIVE_PROMPT: JsonSchema = { type: 'string', maxLength: 600 };

const FRAMING: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 300,
  description:
    'Where the camera stands and what it sees — its position, its height, how close it is, which ' +
    'way it looks and what fills the frame. A keyframe conditioned on a set plate and given no ' +
    'camera reproduces the plate’s own framing, because that is the cheapest way to answer “the ' +
    'same place”: the world holds and every shot comes back the same picture. Two shots of one ' +
    'location differ here or they do not differ at all',
};

/**
 * The still a shot animates, and the recipe that made it. A pinned frame of
 * unknown origin is where a film's consistency was previously decided and never
 * recorded: this render is the one the plates reach, so it is the one whose
 * inputs a later reader has to be able to compare against.
 *
 * The grade plate is named here rather than read from the film at render time
 * for the same reason a take records its provenance — a film that regrades
 * leaves every keyframe naming the plate it was actually authored against, and
 * the difference is what says a re-render is owed.
 */
const KEYFRAME_RECIPE: JsonSchema = {
  type: 'object',
  properties: {
    framing: FRAMING,
    prompt: {
      ...PROMPT,
      description:
        'The shot as a still — who is present and what is happening at the instant the clip ' +
        'starts. Movement belongs to the shot’s own prompt, which animates this frame',
    },
    route: {
      enum: IMAGE_ROUTE_KEYS,
      description: 'The image route this frame renders through',
    },
    gradePlate: REF.pin,
  },
  required: ['framing', 'prompt', 'route', 'gradePlate'],
  additionalProperties: false,
  description:
    'How this shot’s first frame is made: its framing, what it shows, the route that renders it, ' +
    'and the grade plate it is authored against. The frame it renders to is the shot’s keyframe. ' +
    'A render reads one prompt, so the two halves are sent as one — the framing first and the ' +
    'still’s prompt after it, separated by a space. Sending the prompt alone renders the shot ' +
    'with the camera the set plate came with, which is the whole reason the framing is a field',
};

/**
 * A keyframe says what it answered, for the same reason a take does: it is the
 * only way a reader can tell a current frame from one the shot has since edited
 * past. A frame recorded without it reads as current forever, and the clip
 * animated from it is then measured against a render that never happened.
 *
 * The entities are here because they condition this render — a repinned
 * character leaves the frame showing the version it was rendered with, and
 * nothing else on the shot would notice.
 *
 * The two branches keep the pair honest — a frame with no provenance and a
 * provenance with no frame are both unwritable — while `asset` resolves on
 * either, which is what lets a take assert the frame it animated. A member that
 * only exists on one branch cannot be addressed by a template patch at all.
 */
/**
 * The subject's dominant travel across the frame. Closed rather than prose
 * because the whole point is that two shots' directions can be compared —
 * a cut that flips it reads as the subject reversing course, and no reading
 * can compare sentences. Composed into both render prompts by the same rule
 * that carries `framing`, so the declared direction is the rendered one.
 */
export const SCREEN_DIRECTIONS = [
  'none',
  'left_to_right',
  'right_to_left',
  'toward',
  'away',
] as const;

export const SCREEN_DIRECTION: JsonSchema = {
  enum: [...SCREEN_DIRECTIONS],
  description:
    'Which way the subject travels across the frame — `none` for a static ' +
    'subject or an empty frame. Spoken in both render prompts, compared across ' +
    'a cut: two adjacent shots in one scene whose directions oppose read as ' +
    'the subject turning around',
};

export const SCENE_ID: JsonSchema = {
  type: 'string',
  pattern: SCENE_ID_PATTERN,
  minLength: 9,
  maxLength: 23,
  description: "Scene id — 'sc_' plus at least six random lowercase alphanumerics",
};

/**
 * Continuous time in one place. What a scene asserts is exactly what a cut
 * inside it implies — no time has passed, nobody has moved — so the axes that
 * must agree across its shots are named once on the group instead of policed
 * per pair. A cut across a scene boundary asserts nothing.
 */
export const SCENE: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    note: { type: 'string', maxLength: 600 },
  },
  required: ['name', 'note'],
  additionalProperties: false,
};

export const RENDERED_KEYFRAME: JsonSchema = {
  type: 'object',
  properties: {
    asset: REF.pin,
    renderedFrom: {
      type: 'object',
      properties: {
        recipe: REF.keyframeRecipe,
        entities: REF.shotEntities,
        screenDirection: SCREEN_DIRECTION,
      },
      required: ['recipe', 'entities', 'screenDirection'],
      additionalProperties: false,
    },
  },
  required: ['asset', 'renderedFrom'],
  additionalProperties: false,
  description: 'The frame this shot animates, and what its render read',
};

const KEYFRAME: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { asset: { type: 'null' }, renderedFrom: { type: 'null' } },
      required: ['asset', 'renderedFrom'],
      additionalProperties: false,
      description: 'No frame rendered yet',
    },
    RENDERED_KEYFRAME,
  ],
};

const SHOT_ENTITIES: JsonSchema = {
  type: 'object',
  maxProperties: 12,
  propertyNames: { pattern: ROLE_PATTERN },
  additionalProperties: REF.entityBinding,
  description:
    'Role → the entity version this shot renders against. Everything bound here conditions the ' +
    'keyframe, and the characters among them condition the motion as well. What a conditioned ' +
    'render counts is distinct entity names, not roles: two roles holding the same name are one ' +
    'identity to the route, and the ceiling is far lower than this map holds — a shot past it is ' +
    'refused rather than rendered missing someone',
};

/**
 * Every axis that decides what comes back from a generation. Recording them on
 * the take is what makes staleness a comparison instead of a memory: the shot
 * says what it asks for now, the take says what it was answered from, and a
 * reviewer reads the difference. Nothing here is derivable from the shot — the
 * shot has already moved on.
 *
 * An axis a render reads and this does not record is an edit that leaves a take
 * reading as current, and the cut then plays media the shot no longer asks for.
 * `durationSeconds` is here for that reason: re-timing a shot changes the clip
 * and nothing else would have noticed.
 */
const TAKE_PROVENANCE: JsonSchema = {
  type: 'object',
  properties: {
    prompt: PROMPT,
    negativePrompt: NEGATIVE_PROMPT,
    screenDirection: SCREEN_DIRECTION,
    durationSeconds: DURATION_SECONDS,
    route: REF.route,
    conditioning: REF.conditioning,
    // The frame the render read, and not how that frame was made: a recipe
    // edited after the still was rendered changes nothing this clip answered,
    // and the keyframe's own record is where that comparison belongs.
    keyframe: NULLABLE_PIN,
    entities: REF.shotEntities,
  },
  required: [
    'prompt',
    'negativePrompt',
    'screenDirection',
    'durationSeconds',
    'route',
    'conditioning',
    'keyframe',
    'entities',
  ],
  additionalProperties: false,
  description:
    'The shot as it stood when this take was rendered — a take whose provenance differs from its ' +
    'shot is stale, and a re-render is owed',
};

const TAKE: JsonSchema = {
  type: 'object',
  properties: {
    takeId: { type: 'string', minLength: 2, maxLength: 64 },
    asset: REF.pin,
    note: { type: 'string', maxLength: 300 },
    renderedFrom: TAKE_PROVENANCE,
  },
  required: ['takeId', 'asset', 'note', 'renderedFrom'],
  additionalProperties: false,
};

export const SHOT: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    prompt: PROMPT,
    negativePrompt: NEGATIVE_PROMPT,
    screenDirection: SCREEN_DIRECTION,
    sceneId: {
      oneOf: [{ type: 'null' }, SCENE_ID],
      description:
        'The scene this shot plays inside, or null for a shot the cut makes no continuity claim ' +
        'about. Continuity is read only between adjacent shots of one scene',
    },
    durationSeconds: DURATION_SECONDS,
    speed: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 4,
      description: 'Playback rate applied at assembly — below 1 is slower',
    },
    route: REF.route,
    conditioning: REF.conditioning,
    keyframeRecipe: {
      oneOf: [{ type: 'null' }, REF.keyframeRecipe],
      description:
        'How this shot’s first frame is made. Null is a shot that animates nothing — a shot ' +
        'conditioning on references or on frames with no recipe here can never be generated, ' +
        'because the only remaining way to render it carries no references at all',
    },
    keyframe: SHOT_KEYFRAME,
    entities: REF.shotEntities,
    selectedTake: { oneOf: [{ type: 'null' }, REF.take] },
    takes: {
      oneOf: [{ type: 'null' }, REF.pin],
      description:
        'The take history — every generation this shot has produced, the rejected ones included',
    },
    note: { type: 'string', maxLength: 600 },
  },
  required: [
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
  ],
  additionalProperties: false,
};

export const SHOT_DOCUMENTS: JsonSchema = {
  type: 'object',
  properties: { receipts: NULLABLE_PIN, qc: NULLABLE_PIN },
  required: ['receipts', 'qc'],
  additionalProperties: false,
  description:
    'The audit sidecar — what the generations cost and what the QC pass found, pinned rather than ' +
    'carried; a QC finding the room must act on belongs in a marker',
};

/** Every schema document that embeds a shared shape carries these. */
export const BASE_DEFS: JsonSchema = {
  pin: PIN,
  rationalTime: RATIONAL_TIME,
  timeRange: TIME_RANGE,
  entityBinding: ENTITY_BINDING,
  shotEntities: SHOT_ENTITIES,
  route: ROUTE,
  keyframeRecipe: KEYFRAME_RECIPE,
  keyframe: KEYFRAME,
  conditioning: CONDITIONING,
  take: TAKE,
};

export const CLIP: JsonSchema = {
  type: 'object',
  properties: { kind: { const: 'clip' }, shotId: SHOT_ID, sourceRange: REF.timeRange },
  required: ['kind', 'shotId', 'sourceRange'],
  additionalProperties: false,
  description: "A shot placed on a track — it plays the shot's selected take",
};

const AUDIO_CLIP: JsonSchema = {
  type: 'object',
  properties: {
    kind: { const: 'audio' },
    asset: REF.pin,
    sourceRange: REF.timeRange,
    gainDb: { type: 'number', minimum: -60, maximum: 12 },
  },
  required: ['kind', 'asset', 'sourceRange', 'gainDb'],
  additionalProperties: false,
};

const GAP: JsonSchema = {
  type: 'object',
  properties: { kind: { const: 'gap' }, duration: REF.rationalTime },
  required: ['kind', 'duration'],
  additionalProperties: false,
};

const TRANSITION: JsonSchema = {
  type: 'object',
  properties: {
    kind: { const: 'transition' },
    style: { enum: ['dissolve', 'fade_in', 'fade_out', 'wipe'] },
    inOffset: REF.rationalTime,
    outOffset: REF.rationalTime,
  },
  required: ['kind', 'style', 'inOffset', 'outOffset'],
  additionalProperties: false,
};

const TIMELINE_ITEM: JsonSchema = { oneOf: [CLIP, AUDIO_CLIP, GAP, TRANSITION] };

/**
 * What an actor may place on a track by hand — a clip is not in it. A clip and
 * the shot it plays are minted together under one id by add_shot and leave
 * together by remove_shot, so there is no shape in which a clip names a shot
 * nothing declared.
 */
export const PLACEABLE_ITEM: JsonSchema = { oneOf: [AUDIO_CLIP, GAP, TRANSITION] };

export const TRACK: JsonSchema = {
  type: 'object',
  properties: {
    kind: { enum: ['video', 'audio'] },
    name: { type: 'string', minLength: 1, maxLength: 40 },
    items: {
      type: 'array',
      maxItems: 150,
      items: TIMELINE_ITEM,
      description:
        'Played in order — an item starts where the previous one ended, so a gap is how silence ' +
        'or black is expressed',
    },
  },
  required: ['kind', 'name', 'items'],
  additionalProperties: false,
};

/**
 * The look, as an image every keyframe is authored against and as the words the
 * room argues about. The prose alone reaches no render — a grade nothing
 * conditions on is a grade the film does not have — and the plate alone leaves
 * the room with nothing to discuss.
 */
export const GRADE: JsonSchema = {
  type: 'object',
  properties: {
    look: { type: 'string', maxLength: 300 },
    note: { type: 'string', maxLength: 600 },
    plate: {
      oneOf: [{ type: 'null' }, REF.pin],
      description:
        'The graded plate — palette and light with no scene in it, rendered once and named by ' +
        'every keyframe after it. A film with none of these cannot give a shot a recipe, which ' +
        'is what keeps the look ahead of the shots rather than distilled out of the first one',
    },
  },
  required: ['look', 'note', 'plate'],
  additionalProperties: false,
};

export const MARKER: JsonSchema = {
  type: 'object',
  properties: {
    shotId: { oneOf: [{ type: 'null' }, SHOT_ID] },
    at: REF.rationalTime,
    comment: { type: 'string', minLength: 1, maxLength: 600 },
  },
  required: ['shotId', 'at', 'comment'],
  additionalProperties: false,
};
