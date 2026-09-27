/**
 * Hand-authored film applet fixture — a film project the room edits together.
 * The state IS the edit decision list: the document the room edits and the
 * document a render serializes into an assembly timeline are the same one. The
 * definition is parsed at module load so an invalid fixture fails the build,
 * never a runtime resolve.
 */
import { AppletDefinitionSchema, type AppletDefinition } from '@aflow/schemas';
import {
  SHOT_ID,
  MARKER_ID,
  ROLE,
  REF,
  NULLABLE_PIN,
  PROMPT,
  DURATION_SECONDS,
  NEGATIVE_PROMPT,
  SHOT,
  SHOT_DOCUMENTS,
  BASE_DEFS,
  CLIP,
  PLACEABLE_ITEM,
  TRACK,
  GRADE,
  MARKER,
  SHOT_ID_PATTERN,
  MARKER_ID_PATTERN,
  SHOT_CAP,
  OPEN_NOTE_CAP,
  ENTITY_KEY_PATTERN,
  RENDERED_KEYFRAME,
  SCENE,
  SCENE_ID,
  SCENE_ID_PATTERN,
  SCENE_CAP,
  SCREEN_DIRECTION,
  ROUTE_READS_THE_CONDITIONING,
  CASTING_ENTRY,
} from './filmShapes.js';

export const FILM_DEFINITION: AppletDefinition = AppletDefinitionSchema.parse({
  appletKey: 'film',
  version: 10,
  name: 'Film',
  description:
    'A film the room makes together — shots, takes, the timeline and the grade, edited by whoever ' +
    'is in the room and by the agent through the same actions.',
  semanticDescription:
    'A film project. This state IS the edit decision list: what the room edits here is what a ' +
    'render assembles, so there is no separate document to keep in sync. A shot is one generated ' +
    'clip — prompt, conditioning, route, duration and speed — and lives in state.shots under an ' +
    "id like 'sh_7fq2k1de'; a shot that animates a frame is two renders, the still first and the " +
    'clip from it; the timeline places shots as clips on tracks that play in order, with ' +
    'a video track and an audio track present from the start. state.entities is the library of ' +
    'characters, sets, props, wardrobe and styles the film is consistent about; a shot binds an ' +
    'entity into a role (lead, kitchen, hero_mug) and that binding names an exact Memory version ' +
    'and content hash, so revising the library never changes what an existing shot re-renders — ' +
    'to change a shot, rebind its role. state.casting is the casting sheet — every entity the film needs described in words before its plate exists, drafted at concept time, approved by the room, and kept afterwards as the canonical description the plates and every render are judged against; the key a line is drafted under is the key the library binds its plate to. The film’s world is authored before its shots: a graded ' +
    'plate at state.grade.plate, a set plate and a character plate in the library, each rendered ' +
    'once and named by everything after it. A shot animates a keyframe, and the keyframe is ' +
    'where those plates reach a render — it carries its own framing, its own prompt, the image ' +
    'route it renders through and the grade plate it was authored against, so a shot cannot be ' +
    'given a recipe before the film has a look. Deriving the look from the first shot instead is ' +
    'what makes a sequence drift: that shot becomes the authority, its accidents spread and ' +
    'whatever it never showed disappears. Generation returns takes; one take per shot becomes ' +
    'state.shots[id].selectedTake, carrying renderedFrom — the prompt, route, conditioning, ' +
    'keyframe and entity bindings it was rendered against. The keyframe at state.shots[id].' +
    'keyframe says the same about itself, carrying the recipe and the bindings its own render ' +
    'read. Both are stale when their renderedFrom differs from the shot as it now stands, so ' +
    'staleness is read by comparing the two and never stored; a shot with no keyframe owes a ' +
    'still, a shot with no selectedTake owes a clip, and every one of those readings comes from ' +
    'the document rather than from a status anyone maintains. The full take history is a Memory ' +
    'document pinned at state.shots[id].takes; the generation receipts and the QC report are ' +
    'pinned in state.shotAssets, which the agent does not read — a QC finding that needs acting ' +
    'on is written as a marker, and so is anything blocking a shot. ' +
    'state.grade is the whole film’s look — a plate every keyframe is authored against and the ' +
    'words the room agreed on — because colour drift betrays a sequence faster than a face does; ' +
    'takes are judged in sequence rather than one at a time, since drift shows up across shots ' +
    'and not inside one, and a shot whose keyframe names a plate the film has moved off owes a ' +
    'new still. Continuity between shots lives in two members: state.scenes groups shots into ' +
    'continuous time in one place (a shot joins through its sceneId), and every shot carries a ' +
    'screenDirection — the subject’s travel across the frame, spoken in both render prompts. ' +
    'Adjacent shots of one scene whose directions oppose read as the subject turning around, and ' +
    'ones bound to different set entities read as a teleport; both are read off the document at ' +
    'review time, never stored, and both warn rather than block because sometimes the flip is ' +
    'the shot. Timeline edits are ' +
    'addressed by position: read the track, pass the index, and name the clip you mean in the ' +
    'same call — the edit is refused unless the item at that position is that clip.',
  stateSchema: {
    type: 'object',
    $defs: BASE_DEFS,
    properties: {
      project: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          logline: { type: 'string', maxLength: 600 },
          aspectRatio: { enum: ['16:9', '9:16', '1:1', '4:3', '2.39:1'] },
          fps: { enum: [24, 25, 30, 60] },
        },
        required: ['title', 'logline', 'aspectRatio', 'fps'],
        additionalProperties: false,
      },
      grade: GRADE,
      entities: {
        type: 'object',
        maxProperties: 60,
        propertyNames: { pattern: ENTITY_KEY_PATTERN },
        additionalProperties: REF.entityBinding,
        description: 'The film’s entity library — the version each entity is currently pinned at',
      },
      casting: {
        type: 'object',
        maxProperties: 60,
        propertyNames: { pattern: ENTITY_KEY_PATTERN },
        additionalProperties: CASTING_ENTRY,
        description:
          'The casting sheet — every entity the film needs, in words, drafted before the ' +
          'library holds its plate and kept as the canonical description afterwards. A key ' +
          'here is the key the library binds the rendered plate under',
      },
      shots: {
        type: 'object',
        maxProperties: SHOT_CAP,
        propertyNames: { pattern: SHOT_ID_PATTERN },
        additionalProperties: SHOT,
      },
      shotAssets: {
        type: 'object',
        maxProperties: SHOT_CAP,
        propertyNames: { pattern: SHOT_ID_PATTERN },
        additionalProperties: SHOT_DOCUMENTS,
      },
      timeline: {
        type: 'object',
        properties: { tracks: { type: 'array', minItems: 2, maxItems: 4, items: TRACK } },
        required: ['tracks'],
        additionalProperties: false,
      },
      scenes: {
        type: 'object',
        maxProperties: SCENE_CAP,
        propertyNames: { pattern: SCENE_ID_PATTERN },
        additionalProperties: SCENE,
        description:
          'Continuous time in one place — the group a continuity claim is scoped to. Shots join ' +
          'through their sceneId; continuity is read only between adjacent shots of one scene',
      },
      markers: {
        type: 'object',
        maxProperties: OPEN_NOTE_CAP,
        propertyNames: { pattern: MARKER_ID_PATTERN },
        additionalProperties: MARKER,
        description:
          'The open timecoded notes on the cut — resolving one removes it, and what it said stays ' +
          'in the journal',
      },
    },
    required: [
      'project',
      'grade',
      'entities',
      'casting',
      'scenes',
      'shots',
      'shotAssets',
      'timeline',
      'markers',
    ],
    additionalProperties: false,
  },
  initialState: {
    project: {
      title: 'Untitled film',
      logline: '',
      aspectRatio: '16:9',
      fps: 24,
    },
    grade: { look: '', note: '', plate: null },
    entities: {},
    casting: {},
    shots: {},
    shotAssets: {},
    timeline: {
      tracks: [
        { kind: 'video', name: 'V1', items: [] },
        { kind: 'audio', name: 'A1', items: [] },
      ],
    },
    scenes: {},
    markers: {},
  },
  // A projection pointer is literal — there is no way to prune one field out of
  // a dynamically-keyed member — so what a review turn reads has to live inside
  // a projected member. The take history moved onto the shot for that reason;
  // /shotAssets keeps only the cost and QC pins, which no turn reasons over.
  agentProjection: [
    '/project',
    '/grade',
    '/entities',
    '/casting',
    '/scenes',
    '/shots',
    '/timeline',
    '/markers',
  ],
  roles: [
    {
      id: 'director',
      description: 'Owns the logline, the look and what the film is trying to say',
    },
    { id: 'editor', description: 'Assembles the cut, selects takes and trims clips' },
    { id: 'reviewer', description: 'Watches the cut and leaves timecoded comments' },
  ],
  actions: [
    {
      name: 'set_project',
      description: 'Set the film’s title, logline, aspect ratio and frame rate',
      whenToUse: ['Starting the film, or restating what it is'],
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          logline: { type: 'string', maxLength: 600 },
          aspectRatio: { enum: ['16:9', '9:16', '1:1', '4:3', '2.39:1'] },
          fps: { enum: [24, 25, 30, 60] },
        },
        required: ['title', 'logline', 'aspectRatio', 'fps'],
        additionalProperties: false,
      },
      patch: {
        template: [
          { op: 'replace', path: '/state/project/title', valueFrom: '/input/title' },
          { op: 'replace', path: '/state/project/logline', valueFrom: '/input/logline' },
          { op: 'replace', path: '/state/project/aspectRatio', valueFrom: '/input/aspectRatio' },
          { op: 'replace', path: '/state/project/fps', valueFrom: '/input/fps' },
        ],
      },
    },
    {
      name: 'set_grade',
      description:
        'Set the film’s grade — the plate every keyframe is authored against, and the words for it',
      whenToUse: [
        'Starting the film — the grade comes before the shots, not out of them',
        'The room agrees on the look, or the look needs to change across the film',
      ],
      pitfalls: [
        'One grade for the whole film — a per-shot grade is how a sequence starts to drift',
        'Render the plate as palette and light with no scene in it: a plate that shows a place ' +
          'makes every shot reproduce that place, and a plate distilled from a finished shot ' +
          'carries that shot’s accidents into all the others',
        'Regrading leaves every existing keyframe naming the old plate — those shots owe a ' +
          're-render, and the difference is how they say so',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: { grade: GRADE },
        required: ['grade'],
        additionalProperties: false,
      },
      patch: {
        template: [{ op: 'replace', path: '/state/grade', valueFrom: '/input/grade' }],
      },
    },
    {
      name: 'bind_entity',
      description: 'Add or repin an entity in the film’s library at an exact Memory version',
      whenToUse: [
        'A character sheet, set plate or style reference has been written to Memory',
        'A revised reference pack should become the version new shots bind',
      ],
      pitfalls: [
        'When the key is on the casting sheet, the binding carries the sheet’s name verbatim — ' +
          'the prompts were written speaking it, and a binding named differently renders every ' +
          'conditioned shot without its cast',
        'Repinning the library never touches shots already bound — rebind each shot you want moved',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: {
          entityKey: { type: 'string', pattern: ENTITY_KEY_PATTERN, minLength: 2, maxLength: 32 },
          entity: REF.entityBinding,
        },
        required: ['entityKey', 'entity'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: ['/state/entities', { from: '/input/entityKey' }],
            valueFrom: '/input/entity',
          },
        ],
      },
    },
    {
      name: 'draft_casting',
      description:
        'Draft or revise one line of the casting sheet — an entity the film needs, in words',
      whenToUse: [
        'The concept names who and what the film needs before any plate is rendered',
        'The room redirects a description — recast here, and the plate is re-rendered from it',
      ],
      pitfalls: [
        'The key drafted here is the key the library binds the plate under — changing the key ' +
          'later orphans the plate from its description',
        'Revising a brief whose plate is already rendered leaves the plate answering the old ' +
          'words — the world pass owes a new plate, read by comparing, never stored',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: {
          entityKey: {
            type: 'string',
            pattern: ENTITY_KEY_PATTERN,
            minLength: 2,
            maxLength: 32,
          },
          casting: CASTING_ENTRY,
        },
        required: ['entityKey', 'casting'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: ['/state/casting', { from: '/input/entityKey' }],
            valueFrom: '/input/casting',
          },
        ],
      },
    },
    {
      name: 'strike_casting',
      description: 'Remove one line of the casting sheet',
      whenToUse: ['The concept dropped an entity before its plate was rendered'],
      pitfalls: [
        'Striking a line whose plate is already in the library removes the description, not the ' +
          'plate — the entity keeps rendering, now judged against nothing',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          entityKey: {
            type: 'string',
            pattern: ENTITY_KEY_PATTERN,
            minLength: 2,
            maxLength: 32,
          },
        },
        required: ['entityKey'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'remove',
            pathTemplate: ['/state/casting', { from: '/input/entityKey' }],
          },
        ],
      },
    },
    {
      name: 'add_shot',
      description: 'Add a shot and place it at the end of the main video track',
      whenToUse: ['The shot list grows — one shot is one generated clip'],
      pitfalls: [
        'The id lives once, in clip.shotId — mint it with randomness, an existing id is overwritten',
        'Reference conditioning uses whatever this shot has bound — bind the entities in the same pass',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: { shot: { ...SHOT, allOf: [ROUTE_READS_THE_CONDITIONING] }, clip: CLIP },
        required: ['shot', 'clip'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: ['/state/shots', { from: '/input/clip/shotId' }],
            valueFrom: '/input/shot',
          },
          {
            op: 'add',
            pathTemplate: ['/state/shotAssets', { from: '/input/clip/shotId' }],
            value: { receipts: null, qc: null },
          },
          { op: 'add', path: '/state/timeline/tracks/0/items/-', valueFrom: '/input/clip' },
        ],
      },
    },
    {
      name: 'set_prompt',
      description:
        'Rewrite what one shot says — its prompt, its negative prompt and the direction its ' +
        'subject travels',
      whenToUse: ['A shot needs to say something different — the surgical edit'],
      pitfalls: [
        'A shot conditioning on its bindings needs the prompt to keep calling each bound entity ' +
          'by the name its binding carries — rewriting the character as “the woman” leaves the ' +
          'shot unrenderable until one of the two is put back',
        'The direction is compared across cuts inside a scene, so flipping it against the ' +
          'neighbouring shot reads as the subject turning around — say so in the shot, or expect ' +
          'the continuity note',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          shotId: SHOT_ID,
          prompt: PROMPT,
          negativePrompt: NEGATIVE_PROMPT,
          screenDirection: SCREEN_DIRECTION,
        },
        required: ['shotId', 'prompt', 'negativePrompt', 'screenDirection'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'prompt'],
            valueFrom: '/input/prompt',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'negativePrompt'],
            valueFrom: '/input/negativePrompt',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'screenDirection'],
            valueFrom: '/input/screenDirection',
          },
        ],
      },
    },
    {
      name: 'add_scene',
      description: 'Declare a scene — continuous time in one place — for shots to join',
      whenToUse: [
        'Shots belong together tightly enough that a cut between them means no time has passed',
      ],
      pitfalls: [
        'Mint the id with randomness — an existing scene id is overwritten',
        'A scene is a continuity claim, not a chapter heading: shots that jump in time or place ' +
          'belong in different scenes, or in none',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: { sceneId: SCENE_ID, scene: SCENE },
        required: ['sceneId', 'scene'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: ['/state/scenes', { from: '/input/sceneId' }],
            valueFrom: '/input/scene',
          },
        ],
      },
    },
    {
      name: 'set_scene',
      description: 'Put a shot in a scene, or take it out',
      whenToUse: ['A shot joins the continuity of a scene, or stops belonging to one'],
      pitfalls: [
        'Membership is the whole claim: adjacent shots of one scene are compared for direction ' +
          'flips and location jumps, shots of different scenes never are',
        'Null removes the shot from every continuity reading rather than moving it anywhere',
        'Declare the scene with add_scene first — nothing checks the id, and a sceneId that was ' +
          'never declared groups shots into a scene with no name or note to read',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          shotId: SHOT_ID,
          sceneId: { oneOf: [{ type: 'null' }, SCENE_ID] },
        },
        required: ['shotId', 'sceneId'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'sceneId'],
            valueFrom: '/input/sceneId',
          },
        ],
      },
    },
    {
      name: 'set_route',
      description: 'Point a shot at a different render route, or change its quality pass',
      whenToUse: [
        'The room proves a sequence on a cheap draft route, then re-routes it to the deliverable one',
      ],
      pitfalls: [
        'A re-routed shot owes a new take: the clip in hand answers the old route, and only a ' +
          're-render settles it — so re-route a whole pass at once rather than one shot at a time',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: {
          shotId: SHOT_ID,
          route: REF.route,
        },
        required: ['shotId', 'route'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'route'],
            valueFrom: '/input/route',
          },
        ],
      },
    },
    {
      name: 'set_recipe',
      description:
        'Set how one shot is generated — the route, its conditioning and how its first frame is made',
      whenToUse: ['Choosing or changing the model and what the shot conditions on'],
      pitfalls: [
        'Route and conditioning move together: a route accepts some conditioning modes and not others',
        'A shot conditioning on references or on frames animates its keyframe, so it needs a ' +
          'keyframeRecipe — with none it can only be generated the one way that carries no ' +
          'references, which comes back billed in full and without the character',
        'A shot conditioning on references renders against whatever is bound at the time, so bind ' +
          'the roles before generating rather than after',
        'Say the camera in the keyframe’s framing. Two shots of one place that state no camera ' +
          'come back as the same picture, because the set plate answers “the same place” with ' +
          'its own frame',
        'Editing the recipe leaves the frame already rendered in place, saying which recipe it ' +
          'answered — the shot owes a new one, and record_keyframe is what lands it',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: {
          shotId: SHOT_ID,
          route: REF.route,
          conditioning: REF.conditioning,
          keyframeRecipe: { oneOf: [{ type: 'null' }, REF.keyframeRecipe] },
        },
        required: ['shotId', 'route', 'conditioning', 'keyframeRecipe'],
        additionalProperties: false,
        allOf: [ROUTE_READS_THE_CONDITIONING],
      },
      patch: {
        template: [
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'route'],
            valueFrom: '/input/route',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'conditioning'],
            valueFrom: '/input/conditioning',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'keyframeRecipe'],
            valueFrom: '/input/keyframeRecipe',
          },
        ],
      },
    },
    {
      name: 'set_timing',
      description: 'Set one shot’s generated length and playback speed',
      whenToUse: ['A shot should run longer or shorter, or play slower or faster'],
      pitfalls: ['speed below 1 plays slower; it is applied at assembly and costs no generation'],
      inputSchema: {
        type: 'object',
        properties: {
          shotId: SHOT_ID,
          durationSeconds: DURATION_SECONDS,
          speed: { type: 'number', exclusiveMinimum: 0, maximum: 4 },
        },
        required: ['shotId', 'durationSeconds', 'speed'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'durationSeconds'],
            valueFrom: '/input/durationSeconds',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'speed'],
            valueFrom: '/input/speed',
          },
        ],
      },
    },
    {
      name: 'bind_shot_entity',
      description: 'Bind an entity version into one of a shot’s roles',
      whenToUse: [
        'A shot needs a character, set, prop, wardrobe or style',
        'Swapping who or what is in a shot — bind the same role to a different entity',
      ],
      pitfalls: [
        'Copy the pin from state.entities so every shot conditions on the same version',
        'The role is the handle: rebinding a role swaps what the shot renders, and nothing else changes',
        'The binding’s name is the word the shot’s prompt has to use for it — binding a character ' +
          'the prompt never names by that word renders the shot without them',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: { shotId: SHOT_ID, role: ROLE, entity: REF.entityBinding },
        required: ['shotId', 'role', 'entity'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: [
              '/state/shots',
              { from: '/input/shotId' },
              'entities',
              { from: '/input/role' },
            ],
            valueFrom: '/input/entity',
          },
        ],
      },
    },
    {
      name: 'unbind_shot_entity',
      description: 'Drop a role from a shot',
      whenToUse: ['A shot no longer features that character, prop or set'],
      pitfalls: [
        'A shot conditioning on its bindings just stops conditioning on this one — nothing to restate',
      ],
      inputSchema: {
        type: 'object',
        properties: { shotId: SHOT_ID, role: ROLE },
        required: ['shotId', 'role'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'remove',
            pathTemplate: [
              '/state/shots',
              { from: '/input/shotId' },
              'entities',
              { from: '/input/role' },
            ],
          },
        ],
      },
    },
    {
      name: 'record_keyframe',
      description: 'Record the still a shot’s keyframe recipe rendered to',
      whenToUse: ['A keyframe render came back and the frame is the one the shot should animate'],
      pitfalls: [
        'renderedFrom is the recipe and the bindings the render actually read, copied off the ' +
          'shot — a frame claiming inputs it was not rendered from turns every later comparison ' +
          'into a lie, and nothing downstream can catch it',
        'A new keyframe restales every take on the shot: they animated the frame this one replaced',
        'A frame that answers a recipe the shot has since edited past is recorded, not refused — ' +
          'it says so itself, the shot reads as owing a new one, and editing the recipe back ' +
          'makes it current again without paying for another render',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        // The rendered branch only. The state member is nullable so a shot can
        // be born without a frame, but an action named for recording one must
        // not be the way a paid frame and its provenance leave the document.
        properties: { shotId: SHOT_ID, keyframe: RENDERED_KEYFRAME },
        required: ['shotId', 'keyframe'],
        additionalProperties: false,
      },
      // Nothing is asserted against the live shot, unlike select_take. A take
      // is a claim about the cut and has to match the shot to be made; a
      // keyframe is a record of a render that already happened, and it carries
      // what it answered — so a mismatch is a reading rather than a refusal.
      patch: {
        template: [
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'keyframe'],
            valueFrom: '/input/keyframe',
          },
        ],
      },
    },
    {
      name: 'select_take',
      description: 'Choose the take a shot plays in the cut',
      whenToUse: ['Reviewing generated takes and picking the one that works'],
      pitfalls: [
        'Say why in outcome — the journal is the accept and reject ledger, at no cost in state',
        'Judge in sequence with the grade applied: drift shows up across shots, not inside one',
        'renderedFrom is checked against the shot: a take generated before an edit is refused, ' +
          'and regenerating is the answer',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: { shotId: SHOT_ID, take: REF.take },
        required: ['shotId', 'take'],
        additionalProperties: false,
      },
      // The provenance is asserted against the live shot rather than trusted:
      // a take recorded here was rendered from the shot as it stands, so every
      // later difference is drift and nothing else.
      patch: {
        template: [
          {
            op: 'test',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'prompt'],
            valueFrom: '/input/take/renderedFrom/prompt',
          },
          {
            op: 'test',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'negativePrompt'],
            valueFrom: '/input/take/renderedFrom/negativePrompt',
          },
          {
            op: 'test',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'screenDirection'],
            valueFrom: '/input/take/renderedFrom/screenDirection',
          },
          {
            op: 'test',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'durationSeconds'],
            valueFrom: '/input/take/renderedFrom/durationSeconds',
          },
          {
            op: 'test',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'route'],
            valueFrom: '/input/take/renderedFrom/route',
          },
          {
            op: 'test',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'conditioning'],
            valueFrom: '/input/take/renderedFrom/conditioning',
          },
          {
            op: 'test',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'keyframe', 'asset'],
            valueFrom: '/input/take/renderedFrom/keyframe',
          },
          {
            op: 'test',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'entities'],
            valueFrom: '/input/take/renderedFrom/entities',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'selectedTake'],
            valueFrom: '/input/take',
          },
        ],
      },
    },
    {
      name: 'attach_shot_documents',
      description: 'Pin a shot’s take history, generation receipts and QC report',
      whenToUse: ['A batch finished and its records have been written to Memory'],
      pitfalls: [
        'Take histories and receipts are Memory documents, never state — inlining them fills the instance',
        'Repin takes after every batch: it is the only route from a review turn to the takes that lost',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: {
          shotId: SHOT_ID,
          takes: NULLABLE_PIN,
          receipts: NULLABLE_PIN,
          qc: NULLABLE_PIN,
        },
        required: ['shotId', 'takes', 'receipts', 'qc'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'replace',
            pathTemplate: ['/state/shots', { from: '/input/shotId' }, 'takes'],
            valueFrom: '/input/takes',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/shotAssets', { from: '/input/shotId' }, 'receipts'],
            valueFrom: '/input/receipts',
          },
          {
            op: 'replace',
            pathTemplate: ['/state/shotAssets', { from: '/input/shotId' }, 'qc'],
            valueFrom: '/input/qc',
          },
        ],
      },
    },
    {
      name: 'add_timeline_item',
      description: 'Append an audio clip, a gap or a transition to a track',
      whenToUse: [
        'Laying music or dialogue under the cut',
        'Holding black or silence between shots, or dissolving between them',
      ],
      pitfalls: [
        'A shot’s clip is placed by add_shot — that is the only way a clip reaches a track',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: {
          trackIndex: { type: 'integer', minimum: 0, maximum: 3 },
          item: PLACEABLE_ITEM,
        },
        required: ['trackIndex', 'item'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: ['/state/timeline/tracks', { from: '/input/trackIndex' }, 'items', '-'],
            valueFrom: '/input/item',
          },
        ],
      },
    },
    {
      name: 'remove_timeline_item',
      description: 'Take an audio clip, a gap or a transition off a track',
      whenToUse: ['A bed, a hold or a dissolve is not wanted after all'],
      pitfalls: [
        'Name the kind at that position — the removal is refused if something else is there',
        'A clip leaves with its shot: remove_shot is the only action that takes one off a track',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          trackIndex: { type: 'integer', minimum: 0, maximum: 3 },
          itemIndex: { type: 'integer', minimum: 0 },
          kind: { enum: ['audio', 'gap', 'transition'] },
        },
        required: ['trackIndex', 'itemIndex', 'kind'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'test',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/itemIndex' },
              'kind',
            ],
            valueFrom: '/input/kind',
          },
          {
            op: 'remove',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/itemIndex' },
            ],
          },
        ],
      },
    },
    {
      name: 'add_marker',
      description: 'Leave a timecoded comment on the cut',
      whenToUse: [
        'Watching the cut and something needs saying at a specific moment',
        'A QC pass found something on a shot — the report is a pinned document, the finding is a note',
        'A shot is blocked on something — say what it is here, where the room reads it',
      ],
      pitfalls: [
        'Mint the id with randomness — an existing marker id is overwritten',
        'Resolve notes as they are acted on: the map holds open notes only, and a full one refuses new ones',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: { markerId: MARKER_ID, marker: MARKER },
        required: ['markerId', 'marker'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'add',
            pathTemplate: ['/state/markers', { from: '/input/markerId' }],
            valueFrom: '/input/marker',
          },
        ],
      },
      notable: true,
    },
    {
      name: 'resolve_marker',
      description: 'Close a note — it leaves the cut, and the journal keeps what it said',
      whenToUse: ['The note has been acted on'],
      pitfalls: ['A note that turns out to still stand is a new note, not a reopened one'],
      inputSchema: {
        type: 'object',
        properties: { markerId: MARKER_ID },
        required: ['markerId'],
        additionalProperties: false,
      },
      patch: {
        template: [{ op: 'remove', pathTemplate: ['/state/markers', { from: '/input/markerId' }] }],
      },
    },
    {
      name: 'reorder_shot',
      description: 'Move a clip to another position on its track',
      whenToUse: ['The sequence reads better in a different order'],
      pitfalls: [
        'Pass the clip as it stands at fromIndex — the move is refused unless that is what is there',
        'toIndex is where the clip lands once it has been lifted out, not where it sits now',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: {
          trackIndex: { type: 'integer', minimum: 0, maximum: 3 },
          fromIndex: { type: 'integer', minimum: 0 },
          toIndex: { type: 'integer', minimum: 0 },
          clip: CLIP,
        },
        required: ['trackIndex', 'fromIndex', 'toIndex', 'clip'],
        additionalProperties: false,
      },
      // The clip rides through input because a template patch has neither move
      // nor copy: it is removed and re-added by value. The test is what makes
      // that value the clip already on the track rather than a new one.
      patch: {
        template: [
          {
            op: 'test',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/fromIndex' },
            ],
            valueFrom: '/input/clip',
          },
          {
            op: 'remove',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/fromIndex' },
            ],
          },
          {
            op: 'add',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/toIndex' },
            ],
            valueFrom: '/input/clip',
          },
        ],
      },
      guard: {
        assert: [
          '/state/timeline/tracks',
          { from: '/input/trackIndex' },
          'items',
          { from: '/input/fromIndex' },
          'kind',
        ],
        equals: 'clip',
        onUnverifiable: 'reject',
        message:
          'No clip sits at fromIndex on that track — read the timeline and pass the position the ' +
          'clip is actually at.',
      },
    },
    {
      name: 'remove_shot',
      description: 'Remove a shot, the clip that plays it and its sidecar',
      whenToUse: ['A shot is cut from the film'],
      pitfalls: [
        'The three leave together — there is no way to drop the shot and leave its clip playing',
        'Its take history stays in Memory; only the pins leave state',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          shotId: SHOT_ID,
          trackIndex: { type: 'integer', minimum: 0, maximum: 3 },
          itemIndex: { type: 'integer', minimum: 0 },
        },
        required: ['shotId', 'trackIndex', 'itemIndex'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'test',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/itemIndex' },
              'shotId',
            ],
            valueFrom: '/input/shotId',
          },
          {
            op: 'remove',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/itemIndex' },
            ],
          },
          { op: 'remove', pathTemplate: ['/state/shots', { from: '/input/shotId' }] },
          { op: 'remove', pathTemplate: ['/state/shotAssets', { from: '/input/shotId' }] },
        ],
      },
      guard: {
        assert: [
          '/state/timeline/tracks',
          { from: '/input/trackIndex' },
          'items',
          { from: '/input/itemIndex' },
          'kind',
        ],
        equals: 'clip',
        onUnverifiable: 'reject',
        message:
          'No clip sits at that position on that track — read the timeline and pass the position of ' +
          'the clip that plays this shot.',
      },
    },
    {
      name: 'trim_clip',
      description: 'Trim a clip — which part of its take plays',
      whenToUse: ['A take is right but starts late or runs long'],
      pitfalls: [
        'Name the shot as well as the position — the trim is refused if another clip is there',
        'Trimming changes the cut, not the take: nothing is regenerated',
      ],
      inputSchema: {
        type: 'object',
        $defs: BASE_DEFS,
        properties: {
          shotId: SHOT_ID,
          trackIndex: { type: 'integer', minimum: 0, maximum: 3 },
          itemIndex: { type: 'integer', minimum: 0 },
          sourceRange: REF.timeRange,
        },
        required: ['shotId', 'trackIndex', 'itemIndex', 'sourceRange'],
        additionalProperties: false,
      },
      patch: {
        template: [
          {
            op: 'test',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/itemIndex' },
              'shotId',
            ],
            valueFrom: '/input/shotId',
          },
          {
            op: 'replace',
            pathTemplate: [
              '/state/timeline/tracks',
              { from: '/input/trackIndex' },
              'items',
              { from: '/input/itemIndex' },
              'sourceRange',
            ],
            valueFrom: '/input/sourceRange',
          },
        ],
      },
      guard: {
        assert: [
          '/state/timeline/tracks',
          { from: '/input/trackIndex' },
          'items',
          { from: '/input/itemIndex' },
          'kind',
        ],
        equals: 'clip',
        onUnverifiable: 'reject',
        message:
          'No clip sits at that position on that track — read the timeline and pass the position ' +
          'of the clip you mean. An audio bed is re-placed rather than trimmed.',
      },
    },
  ],
  // An attention pointer is literal, so anything it names has to be stored.
  // Where the film stands is a consequence of the shots and the timeline —
  // stored, it would go on reading 'shot list' over a finished film — so the
  // title is the only thing here that survives being read back, and what the
  // room is waiting on is derived where it is shown.
  attentionProjection: { title: '/project/title' },
  situationProjection: ['/project/logline', '/grade/look'],
});

// The compiler exposes no stable build-time hash for the DS contract yet, so
// the pin rides catalogVersion; 'fallback' marks the hash slot as
// intentionally unpinned.
export const FILM_CATALOG_PIN = {
  catalogId: 'phoenix-design-system',
  catalogVersion: '2.0.0-artifact',
  catalogHash: 'fallback',
} as const;

export { FILM_VIEW_SOURCE } from './filmView.js';
