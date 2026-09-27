import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import { WORLD_DEVELOP_PROMPT, WORLD_SUMMARY_PROMPT } from './filmWorldDevelopmentProse.js';

/**
 * The seam between this skill and the render skill is the seam between
 * authoring a world and paying to photograph it: this pass renders plates and
 * writes the document; keyframes and clips belong to the render pass. One
 * agent task rather than a task per plate, for the same reason the render
 * skill is: the graph is static and a world has as many plates as it has.
 */
const FILM_WORLD_DEVELOPMENT: SkillCatalogEntry = {
  catalogId: 'film-world-development',
  version: 4,
  name: 'Develop the Film World',
  tagline:
    'Turn an operator’s idea into an authored film world — the grade, the places, the cast, and the shots that will be rendered from them.',
  description: `Takes one film applet instance and the operator's brief, and authors the world the film will be rendered from: the grade plate the whole film answers to, set and character plates bound into the library, and the scenes and shots that stand on them.

**The brief is written in the operator's language, and so is the report.** What the film is, who is in it, where it happens, what it should feel like. What the brief decides, the pass follows; what it leaves open, the pass decides with taste and reports as a decision — so redirecting a choice is a sentence in the room, not a lesson in the tooling. It asks nothing mid-run.

**Order is the ontology.** The grade plate is rendered first — palette and light with no scene in it — because every later plate and keyframe is authored against it. Then the places, empty of people; then the people, against flat neutral light; then the document: scenes as continuity claims, shots with directions, recipes and bindings. Deriving the look from the first scene image instead is what makes a sequence drift.

**It renders plates and nothing else.** Keyframes and clips are the Render Film Shots pass — when the world is authored, "render the shots" produces the film from it.

**It authors only what is missing.** A film that already holds a grade keeps it; an existing entity is cast rather than replaced; existing shots are completed rather than rewritten.

**Prerequisites**: a film applet instance (empty is fine), and a credential for an image-capable provider (Settings → Credentials).`,
  tags: ['film', 'video', 'pre-production', 'world', 'generation', 'applet'],
  bundle: {
    workflow: {
      slug: 'film-world-development',
      name: 'Develop the Film World',
      description:
        'Read one film and the operator’s brief, render the plates the world is missing, bind the cast and places into the library, author the scenes and shots, and report every decision the brief left open.',
      goal: 'The film’s world is authored — grade, places, cast, scenes and shots — or every missing piece carries a reason, and every choice the brief left open is reported as a decision.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'nothing-unexplained',
          name: 'Nothing left unexplained',
          evaluator: {
            type: 'threshold' as const,
            metric: 'unexplained',
            operator: 'lte' as const,
            target: 0,
          },
        },
      ],
      runInputs: [
        {
          id: 'appletInstanceId',
          required: true,
          description:
            'The film applet instance to develop — the id of the film whose world this pass authors. An empty film is fine; create one first when none exists.',
        },
        {
          id: 'brief',
          required: true,
          description:
            'The operator’s idea in their own words: what the film is, who is in it, where it happens, what it should feel like. This is the creative authority for the whole pass.',
        },
        {
          id: 'direction',
          required: false,
          description:
            'Optional special direction — look words, casting notes, constraints ("shot like a 70s thriller", "the courier is in her fifties", "never show the sky").',
        },
        {
          id: 'maxRenders',
          required: true,
          description:
            'The most plates this pass may render. Each plate is a paid image render, so this is the run’s spend ceiling stated in plates — a small film’s world is typically 3 to 6. The pass holds this ceiling itself; the platform does not yet meter paid calls.',
        },
      ],
      tasks: [
        {
          taskId: 'develop-world',
          name: 'Author the world the brief describes',
          goal: WORLD_DEVELOP_PROMPT,
          type: 'agent' as const,
          // Not auto-retried: a retried attempt re-enters from the top and
          // re-renders plates the last attempt had bought but not yet bound.
          retryability: 'unsafe' as const,
          inputBindings: {
            appletInstanceId: { kind: 'run_input' as const, path: 'appletInstanceId' },
            brief: { kind: 'run_input' as const, path: 'brief' },
            direction: { kind: 'run_input' as const, path: 'direction' },
            maxRenders: { kind: 'run_input' as const, path: 'maxRenders' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              // Read the film, render a plate, write the document. Nothing here
              // writes to Memory directly — a render files its own bytes and
              // hands back the pinned reference an entity or grade records.
              operations: [
                'ui.applet.get',
                'ui.applet.act',
                'ai.media.image',
                'memory.store.get',
                'agent.control.signal_blocked',
              ],
              integrations: [],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['plates', 'cast', 'scenes', 'shots', 'decisions', 'undone', 'unexplained'],
              additionalProperties: false,
              properties: {
                plates: {
                  type: 'array',
                  maxItems: 60,
                  description:
                    'One entry per plate this pass rendered and recorded — the grade, a place, or a person.',
                  items: {
                    type: 'object',
                    required: ['kind', 'name'],
                    additionalProperties: false,
                    properties: {
                      kind: { enum: ['grade', 'set', 'character', 'prop', 'wardrobe', 'style'] },
                      name: { type: 'string', minLength: 1, maxLength: 120 },
                      note: { type: 'string', maxLength: 400 },
                      costUsd: {
                        type: 'number',
                        minimum: 0,
                        description:
                          'What the plate’s render reported it cost, counted once however many times it was called. Omitted, never zero, when no figure was reported.',
                      },
                    },
                  },
                },
                cast: {
                  type: 'array',
                  maxItems: 60,
                  description:
                    'One entry per library entry this pass bound — who and where the film now holds, by the key a shot binds.',
                  items: {
                    type: 'object',
                    required: ['entityKey', 'kind', 'name'],
                    additionalProperties: false,
                    properties: {
                      entityKey: { type: 'string', minLength: 1, maxLength: 40 },
                      kind: { type: 'string', minLength: 1, maxLength: 20 },
                      name: { type: 'string', minLength: 1, maxLength: 120 },
                    },
                  },
                },
                scenes: {
                  type: 'array',
                  maxItems: 45,
                  description: 'One entry per scene this pass declared.',
                  items: {
                    type: 'object',
                    required: ['sceneId', 'name'],
                    additionalProperties: false,
                    properties: {
                      sceneId: { type: 'string', minLength: 1, maxLength: 23 },
                      name: { type: 'string', minLength: 1, maxLength: 120 },
                    },
                  },
                },
                shots: {
                  type: 'array',
                  maxItems: 90,
                  description:
                    'One entry per shot this pass authored or completed — added, bound, put in a scene, or given its recipe.',
                  items: {
                    type: 'object',
                    required: ['shotId', 'name', 'note'],
                    additionalProperties: false,
                    properties: {
                      shotId: { type: 'string', minLength: 1, maxLength: 27 },
                      name: { type: 'string', minLength: 1, maxLength: 120 },
                      note: {
                        type: 'string',
                        maxLength: 400,
                        description: 'What this pass did to the shot, in a phrase.',
                      },
                    },
                  },
                },
                decisions: {
                  type: 'array',
                  maxItems: 60,
                  description:
                    'Every creative choice the brief left open and this pass made — in the operator’s language, each one reversible with a sentence.',
                  items: { type: 'string', minLength: 1, maxLength: 400 },
                },
                undone: {
                  type: 'array',
                  maxItems: 60,
                  description:
                    'What the world still lacks, each entry carrying its reason — a ceiling reached, a refusal in its own words, a brief too silent to decide on.',
                  items: {
                    type: 'object',
                    required: ['what', 'reason'],
                    additionalProperties: false,
                    properties: {
                      what: { type: 'string', minLength: 1, maxLength: 200 },
                      reason: { type: 'string', minLength: 1, maxLength: 800 },
                    },
                  },
                },
                unexplained: {
                  type: 'integer',
                  minimum: 0,
                  description:
                    'Pieces of the world the brief called for that end the pass neither authored nor listed in undone with a reason. Zero is the pass having accounted for everything it touched.',
                },
              },
            },
          },
          // The outcome and the relayed record come from the pass itself: a
          // summary that restates a count can launder a nonzero into zero,
          // and the guidance tells the caller to relay decisions verbatim —
          // which only promoted state can carry.
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'unexplained', toState: 'unexplained' },
            { kind: 'output_path' as const, path: 'decisions', toState: 'decisions' },
            { kind: 'output_path' as const, path: 'undone', toState: 'undone' },
          ],
        },
        {
          taskId: 'summarise-development',
          name: 'Report the world to the operator',
          goal: WORLD_SUMMARY_PROMPT,
          type: 'agent' as const,
          dependsOn: ['develop-world'],
          inputBindings: {
            plates: { kind: 'task_output' as const, taskId: 'develop-world', path: 'plates' },
            cast: { kind: 'task_output' as const, taskId: 'develop-world', path: 'cast' },
            scenes: { kind: 'task_output' as const, taskId: 'develop-world', path: 'scenes' },
            shots: { kind: 'task_output' as const, taskId: 'develop-world', path: 'shots' },
            decisions: { kind: 'task_output' as const, taskId: 'develop-world', path: 'decisions' },
            undone: { kind: 'task_output' as const, taskId: 'develop-world', path: 'undone' },
            unexplained: {
              kind: 'task_output' as const,
              taskId: 'develop-world',
              path: 'unexplained',
            },
          },
          // Pure synthesis over what the development pass reported: a summary
          // that could re-read the film could also disagree with the pass it
          // is summarising.
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: { operations: [], integrations: [] },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['headline', 'decisions', 'undone', 'unexplained'],
              additionalProperties: false,
              properties: {
                headline: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                  description:
                    'What the film’s world now holds, in the operator’s language, ending with what happens next — including "render the shots" when the world is ready.',
                },
                decisions: {
                  type: 'array',
                  maxItems: 60,
                  description:
                    'Carried through from the pass: every choice the brief left open, each reversible with a sentence.',
                  items: { type: 'string', minLength: 1, maxLength: 400 },
                },
                undone: {
                  type: 'array',
                  maxItems: 60,
                  description:
                    'Carried through from the pass: what the world still lacks and why, refusals in their own words.',
                  items: {
                    type: 'object',
                    required: ['what', 'reason'],
                    additionalProperties: false,
                    properties: {
                      what: { type: 'string', minLength: 1, maxLength: 200 },
                      reason: { type: 'string', minLength: 1, maxLength: 800 },
                    },
                  },
                },
                unexplained: {
                  type: 'integer',
                  minimum: 0,
                  description:
                    'Carried through from the pass: pieces of the world called for and neither authored nor explained. Zero is a fully accounted pass.',
                },
              },
            },
          },
          promoteOutputs: [{ kind: 'output_path' as const, path: 'headline', toState: 'headline' }],
        },
      ],
      stateVariables: [
        {
          variableId: 'headline',
          name: 'World headline',
          description: 'What the film’s world now holds, and what happens next.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'unexplained',
          name: 'World left unexplained',
          description:
            'How many pieces of the world the brief called for ended the pass neither authored nor explained.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'decisions',
          name: 'Decisions the brief left open',
          description:
            'Every creative choice the pass made where the brief was silent, each reversible with a sentence.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'undone',
          name: 'World left undone',
          description: 'What the world still lacks and why, in the pass’s own words.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'headline',
        guidance:
          'The film itself is the deliverable — the plates, cast, scenes and shots were written into it, not returned here. Relay the headline, then the decisions verbatim: each one is a choice the operator can reverse with a sentence, and burying one imposes it. When pieces went undone, carry their reasons in the pass’s own words.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'film-world-development',
      name: 'Develop the Film World',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'world-before-shots',
            description:
              'The grade plate exists before any set or character plate, and every keyframe recipe authored names it — the look is never derived from a scene image.',
          },
          {
            id: 'nothing-reauthored',
            description:
              'Nothing the film already held was replaced — existing grades, entities and shots were kept and completed, never re-rendered or rebound.',
          },
          {
            id: 'decisions-reported',
            description:
              'Every creative choice the brief left open is reported as a decision in the operator’s language, reversible with a sentence.',
          },
        ],
      },
      mode: 'process' as const,
    },
    evalSuite: {
      goalCriteria: [],
      taskCriteria: {
        'summarise-development': [
          {
            name: 'world-reports-a-headline',
            type: 'contains' as const,
            inField: 'headline',
            pattern: '\\S',
          },
        ],
      },
      trajectoryCriteria: [],
      weights: { goal: 0, task: 1.0, trajectory: 0 },
      createdAt: CATALOG_EPOCH,
      updatedAt: CATALOG_EPOCH,
      createdBy: 'platform',
    },
    activation: {
      triggerPatterns: [
        'develop the world',
        'render the plates',
        'set up the film',
        'create the characters',
        'build the world',
      ],
      activationHint:
        'One run develops one film’s world, run AFTER the room approved the concept — the casting sheet is its input: it renders the grade, set and character plates, binds the cast and places, and completes the shots — no clips (Render Film Shots does that). Inputs: the film instance id, the brief in the operator’s words, and maxRenders — the spend ceiling in plates. Gather the idea and the ceiling, never applet mechanics; open choices are decided and reported, nothing asked mid-run.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The pass is one agent task because a workflow graph is static and a world has as many plates as it has — the loop lives where a loop can live. What it may do is bounded by the task’s capability list rather than its prompt: it reads the film, renders images, and writes the document through the applet’s own actions; it cannot render video, so the seam between authoring a world and paying to photograph it is structural rather than advised. The document work is checked by the applet gateway — recipes without framings, bindings without pins and scenes with malformed ids refuse at the call — and the elicitation question is settled by placement: creative conversation happens in the room before the run, the pass decides what remains and reports every decision, and a HITL pause never parks a spend ceiling on a person who walked away.',
  },
};

export { FILM_WORLD_DEVELOPMENT };
