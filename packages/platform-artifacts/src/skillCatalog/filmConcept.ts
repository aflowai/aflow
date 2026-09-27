import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import { CONCEPT_DEVELOP_PROMPT, CONCEPT_SUMMARY_PROMPT } from './filmConceptProse.js';

/**
 * The approval seam sits between this skill and the world pass: the concept
 * stages the story, the cast in words, the scenes and the ordered shot list —
 * and renders nothing, structurally, because its capability list carries no
 * media operation. The room approves or redirects the pitch in the chat, and
 * only then does the world pass turn the casting sheet into paid plates.
 */
const FILM_CONCEPT: SkillCatalogEntry = {
  catalogId: 'film-concept',
  version: 1,
  name: 'Stage the Film Concept',
  tagline:
    'Turn an idea into a film the room can read — story, cast, places, scenes and an ordered shot list — before anything is rendered or spent.',
  description: `Takes one film applet instance and the operator's brief, and stages the concept the room approves before production spends: the title and logline, the casting sheet (every entity the film needs, described in words), the scenes as continuity claims, and the shots in the order the story means them to play.

**It renders nothing, structurally.** The pass has no render operation to call — the pitch costs conversation, not money. Approving it, or redirecting any part of it, is a sentence in the room; then "develop the world" renders the plates from the approved casting sheet.

**The casting sheet is the identity contract.** Each line carries the canonical description every later render of that entity is judged against — the plate is rendered from it, and drift is measured back to it.

**A concept is revised, never replaced.** A redirection names what moves; everything it does not name keeps the approval the room already gave.

**Prerequisites**: a film applet instance (empty is fine; create one first when none exists).`,
  tags: ['film', 'video', 'concept', 'pre-production', 'applet'],
  bundle: {
    workflow: {
      slug: 'film-concept',
      name: 'Stage the Film Concept',
      description:
        'Read one film and the operator’s brief, stage the story, casting sheet, scenes and ordered shot list without rendering anything, and report the pitch with every open choice named.',
      goal: 'The film carries a readable concept — story, cast in words, scenes, shots in story order — or every missing piece carries a reason, and every choice the brief left open is reported as a decision.',
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
            'The film applet instance to stage the concept in — an empty film is fine; create one first when none exists.',
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
            'Optional special direction — genre, tone, casting notes, constraints ("shot like a 70s thriller", "the courier is in her fifties", "exactly five shots").',
        },
      ],
      tasks: [
        {
          taskId: 'stage-concept',
          name: 'Stage the concept the brief describes',
          goal: CONCEPT_DEVELOP_PROMPT,
          type: 'agent' as const,
          // Not auto-retried: a re-entered pass re-enters a half-staged
          // document and mints fresh shot and scene ids — the duplicates
          // read as story, and two passes later each one is a paid render.
          retryability: 'unsafe' as const,
          inputBindings: {
            appletInstanceId: { kind: 'run_input' as const, path: 'appletInstanceId' },
            brief: { kind: 'run_input' as const, path: 'brief' },
            direction: { kind: 'run_input' as const, path: 'direction' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              // Read the film, write the document. No render operation exists
              // here at all — the zero-spend claim is the capability list, not
              // the prompt.
              operations: ['ui.applet.get', 'ui.applet.act', 'agent.control.signal_blocked'],
              integrations: [],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: [
                'title',
                'logline',
                'cast',
                'scenes',
                'shots',
                'decisions',
                'undone',
                'unexplained',
              ],
              additionalProperties: false,
              properties: {
                title: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  description: 'The title as written to the film.',
                },
                logline: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 600,
                  description: 'The story in a sentence, as written to the film.',
                },
                cast: {
                  type: 'array',
                  maxItems: 60,
                  description:
                    'The whole casting sheet as it stands after this pass — unchanged approved lines included, because the pitch re-approves the film, not the delta.',
                  items: {
                    type: 'object',
                    required: ['entityKey', 'kind', 'name', 'brief'],
                    additionalProperties: false,
                    properties: {
                      entityKey: { type: 'string', minLength: 1, maxLength: 40 },
                      kind: { type: 'string', minLength: 1, maxLength: 20 },
                      name: { type: 'string', minLength: 1, maxLength: 120 },
                      brief: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 800,
                        description:
                          'The canonical description as written to the sheet — the pitch shows the operator exactly what the plates will be rendered from.',
                      },
                    },
                  },
                },
                scenes: {
                  type: 'array',
                  maxItems: 45,
                  description:
                    'Every scene in the film after this pass, unchanged approved scenes included — the pitch reads scene by scene and resolves shot sceneIds against this list.',
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
                    'Every shot in the film after this pass, in the order the story plays them — unchanged approved shots included, because a partial list is a pitch with holes in the story.',
                  items: {
                    type: 'object',
                    required: ['shotId', 'name', 'note', 'sceneId'],
                    additionalProperties: false,
                    properties: {
                      shotId: { type: 'string', minLength: 1, maxLength: 27 },
                      name: { type: 'string', minLength: 1, maxLength: 120 },
                      note: {
                        type: 'string',
                        maxLength: 400,
                        description: 'What this shot does in the story, in a phrase.',
                      },
                      sceneId: {
                        oneOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 23 }],
                        description:
                          'The scene the shot stands in, so the pitch reads scene by scene.',
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
                  description: 'What the concept still lacks, each entry carrying its reason.',
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
                    'Pieces of the concept the brief called for that end the pass neither staged nor listed in undone with a reason. Zero is the pass having accounted for everything it touched.',
                },
              },
            },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'unexplained', toState: 'unexplained' },
            { kind: 'output_path' as const, path: 'decisions', toState: 'decisions' },
            { kind: 'output_path' as const, path: 'undone', toState: 'undone' },
          ],
        },
        {
          taskId: 'summarise-concept',
          name: 'Pitch the concept to the operator',
          goal: CONCEPT_SUMMARY_PROMPT,
          type: 'agent' as const,
          dependsOn: ['stage-concept'],
          inputBindings: {
            title: { kind: 'task_output' as const, taskId: 'stage-concept', path: 'title' },
            logline: { kind: 'task_output' as const, taskId: 'stage-concept', path: 'logline' },
            cast: { kind: 'task_output' as const, taskId: 'stage-concept', path: 'cast' },
            scenes: { kind: 'task_output' as const, taskId: 'stage-concept', path: 'scenes' },
            shots: { kind: 'task_output' as const, taskId: 'stage-concept', path: 'shots' },
            decisions: {
              kind: 'task_output' as const,
              taskId: 'stage-concept',
              path: 'decisions',
            },
            undone: { kind: 'task_output' as const, taskId: 'stage-concept', path: 'undone' },
            unexplained: {
              kind: 'task_output' as const,
              taskId: 'stage-concept',
              path: 'unexplained',
            },
          },
          // Pure synthesis over what the staging pass reported: a pitch that
          // could re-read the film could also disagree with the pass it is
          // pitching.
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: { operations: [], integrations: [] },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['headline', 'unexplained'],
              additionalProperties: false,
              properties: {
                headline: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 4000,
                  description:
                    'The pitch, in the operator’s language, ending with the approval question — nothing rendered, nothing spent, "develop the world" waits on their word.',
                },
                unexplained: {
                  type: 'integer',
                  minimum: 0,
                  description: 'Carried through from the pass. Zero is a fully accounted pass.',
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
          name: 'The pitch',
          description: 'The concept as the room reads it, ending with the approval question.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'unexplained',
          name: 'Concept left unexplained',
          description:
            'How many pieces of the concept the brief called for ended the pass neither staged nor explained.',
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
          name: 'Concept left undone',
          description: 'What the concept still lacks and why, in the pass’s own words.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'headline',
        guidance:
          'The film itself carries the concept — the pitch is how the room reads it. Relay the headline, then the decisions verbatim: each one is a choice the operator reverses with a sentence. Nothing has been rendered and nothing spent; the next step is theirs — approve, or redirect, and only then run "develop the world".',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'film-concept',
      name: 'Stage the Film Concept',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'nothing-rendered',
            description:
              'The pass spent nothing — its capability list carries no render operation, so the claim is structural.',
          },
          {
            id: 'story-in-order',
            description:
              'The shots stand on the timeline in the order the story means them to play, and the casting sheet describes every entity the shots name.',
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
        'summarise-concept': [
          {
            name: 'concept-reports-a-pitch',
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
        'i have an idea for a film',
        'make a film about',
        'pitch me a film',
        'stage the concept',
        'plan the film',
        'write the story',
      ],
      activationHint:
        'One run stages ONE film’s concept from the operator’s idea, and renders NOTHING — story, casting sheet, scenes and an ordered shot list, staged for approval. Inputs: the film instance id (create an empty film when none exists) and the brief in the operator’s words. Relay the pitch and the decisions; the operator approves or redirects in the room, and only after their word does "develop the world" render the plates. Revisions run this same skill.',
      prerequisites: [],
      priority: 60,
    },
    rationale:
      'The approval seam is placed between skills rather than inside one: a pass that pauses mid-run parks a spend ceiling on a person who walked away, so the concept stage ends where the money starts and the approval is an ordinary conversation turn. The zero-spend claim is the capability list — no media operation exists in the task — and the casting sheet is the contract that crosses the seam: the key a line is drafted under is the key the world pass binds the rendered plate to, and the brief on the line is the canonical description drift is judged against from then on.',
  },
};

export { FILM_CONCEPT };
