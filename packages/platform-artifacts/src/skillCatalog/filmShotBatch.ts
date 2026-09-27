import type { SkillCatalogEntry } from '@aflow/schemas';
import { CATALOG_EPOCH } from './constants.js';
import { BATCH_RENDER_PROMPT, BATCH_SUMMARY_PROMPT } from './filmShotBatchProse.js';

/**
 * The batch is one agent task rather than a task per shot because a workflow's
 * task graph is static: it has `when` and `dependsOn` and no way to fan out
 * over a list nobody knew the length of when the skill was written. A film has
 * as many shots as it has, so the loop lives where a loop can live.
 */
const FILM_SHOT_BATCH: SkillCatalogEntry = {
  catalogId: 'film-shot-batch',
  version: 5,
  name: 'Render Film Shots',
  tagline:
    'Render every shot of a film that owes a take, record each one against the shot it came from, and report what it cost.',
  description: `Takes one film applet instance and produces the shots that do not yet have a usable take — rendering each through the route its own recipe names, recording the result back onto the shot, and reporting what the pass spent.

**A shot owes a take when it has none, or when the take it has was rendered from a shot that has since moved.** Every take records the prompt, route, conditioning and keyframe it was answered from, so "this take is out of date" is a comparison rather than a memory. A shot whose take is current is left alone: renders are paid for one at a time, and re-rolling finished work is the cost this skill exists to avoid.

**A shot that animates a frame is two renders.** The shot names a keyframe recipe — a framing, a still to render, an image route and the film's grade plate — and the frame that recipe produced is what the clip animates. A shot with no frame yet gets one first, conditioned on the entities it has bound and on the grade the film was authored against, and that still is recorded back onto the shot before anything animates it. The world reaching a shot through its plates is what makes one location look like the same location across the whole sequence.

**The film's document is the instruction.** Each shot's prompt, route, length and conditioning are read from the applet and passed through unchanged — a take that was not rendered from the shot as written cannot be traced back to it, and the drift the film reports afterwards would be measured against a render that never happened.

**A refusal is carried, not swallowed.** A shot that cannot be rendered — a length no route renders, a character its prompt stopped naming, a conditioning its route does not read — comes back naming what to change. The run fixes what is unambiguous and reports the rest in the shot's own terms, so the operator learns what to edit rather than that something failed.

**Prerequisites**: a film applet instance with shots, and a credential for whichever provider its shots route through (Settings → Credentials).`,
  tags: ['film', 'video', 'batch', 'generation', 'applet'],
  bundle: {
    workflow: {
      slug: 'film-shot-batch',
      name: 'Render Film Shots',
      description:
        'Read one film, render every shot that owes a take, record each take against the shot it was rendered from, and summarise what the pass produced and spent.',
      goal: 'Every shot of the film that owed a take either carries one rendered from its current recipe, or carries a reason it does not.',
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
            'The film applet instance to produce — the id of the film whose shots this pass renders.',
        },
        {
          id: 'maxShots',
          required: true,
          description:
            'The most shots this pass may render. Each render is paid for, so this is the run’s spend ceiling stated in shots — set it to what you are willing to spend on one pass, not to the size of the film. The pass holds this ceiling itself; the platform does not yet meter paid calls.',
        },
        {
          id: 'note',
          required: false,
          description:
            'Optional instruction narrowing the pass (e.g. "only the shots in the opening scene", "draft quality only").',
        },
      ],
      tasks: [
        {
          taskId: 'render-shots',
          name: 'Render the shots that owe a take',
          goal: BATCH_RENDER_PROMPT,
          type: 'agent' as const,
          // Not auto-retried: a retried attempt re-enters the loop from the
          // top, and the renders it re-issues for shots whose takes the last
          // attempt had not yet recorded are bought again.
          retryability: 'unsafe' as const,
          inputBindings: {
            appletInstanceId: { kind: 'run_input' as const, path: 'appletInstanceId' },
            maxShots: { kind: 'run_input' as const, path: 'maxShots' },
            note: { kind: 'run_input' as const, path: 'note' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              // Read the film, render a shot, record the take. Nothing here
              // writes to Memory directly — a render files its own bytes and
              // hands back the pinned reference a take is recorded against.
              operations: [
                'ui.applet.get',
                'ui.applet.act',
                'ai.media.image',
                'ai.media.video',
                'ai.media.animate',
                'memory.store.get',
                'agent.control.signal_blocked',
              ],
              integrations: [],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['rendered', 'keyframedOnly', 'unrendered', 'unexplained'],
              additionalProperties: false,
              properties: {
                rendered: {
                  type: 'array',
                  maxItems: 200,
                  description: 'One entry per shot that came back with a take and had it recorded.',
                  items: {
                    type: 'object',
                    required: ['shotId', 'note'],
                    additionalProperties: false,
                    properties: {
                      shotId: { type: 'string', minLength: 1, maxLength: 27 },
                      note: { type: 'string', maxLength: 400 },
                      costUsd: {
                        type: 'number',
                        minimum: 0,
                        description:
                          'What this shot cost across every render it took — the keyframe as well as the clip — counted once for the shot however many times each was called. Omitted, never zero, when no figure was reported.',
                      },
                    },
                  },
                },
                keyframedOnly: {
                  type: 'array',
                  maxItems: 200,
                  description:
                    'One entry per shot whose keyframe was rendered and recorded while its clip was not — the still is bought and the motion is not, so it is neither rendered nor untouched.',
                  items: {
                    type: 'object',
                    required: ['shotId', 'reason'],
                    additionalProperties: false,
                    properties: {
                      shotId: { type: 'string', minLength: 1, maxLength: 27 },
                      reason: { type: 'string', minLength: 1, maxLength: 800 },
                      costUsd: {
                        type: 'number',
                        minimum: 0,
                        description:
                          'What the keyframe render reported it cost. Omitted, never zero, when no figure was reported.',
                      },
                    },
                  },
                },
                unrendered: {
                  type: 'array',
                  maxItems: 200,
                  description:
                    'One entry per shot that owed a take and did not get one, carrying the refusal in its own words.',
                  items: {
                    type: 'object',
                    required: ['shotId', 'reason'],
                    additionalProperties: false,
                    properties: {
                      shotId: { type: 'string', minLength: 1, maxLength: 27 },
                      reason: { type: 'string', minLength: 1, maxLength: 800 },
                    },
                  },
                },
                unexplained: {
                  type: 'integer',
                  minimum: 0,
                  description:
                    'Shots that owed a take and end the pass with neither one nor a stated reason — the pass reaching its ceiling, or stopping early. Zero is the pass having accounted for everything it touched.',
                },
              },
            },
          },
          // The outcome and the refusals the caller relays come from the pass
          // itself — a summary restating a count can launder a nonzero into
          // zero, and only promoted state reaches the run result.
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'unexplained', toState: 'unexplained' },
            { kind: 'output_path' as const, path: 'unrendered', toState: 'unrendered' },
            { kind: 'output_path' as const, path: 'keyframedOnly', toState: 'keyframedOnly' },
          ],
        },
        {
          taskId: 'summarise-pass',
          name: 'Summarise the pass',
          goal: BATCH_SUMMARY_PROMPT,
          type: 'agent' as const,
          dependsOn: ['render-shots'],
          inputBindings: {
            rendered: { kind: 'task_output' as const, taskId: 'render-shots', path: 'rendered' },
            keyframedOnly: {
              kind: 'task_output' as const,
              taskId: 'render-shots',
              path: 'keyframedOnly',
            },
            unrendered: {
              kind: 'task_output' as const,
              taskId: 'render-shots',
              path: 'unrendered',
            },
            unexplained: {
              kind: 'task_output' as const,
              taskId: 'render-shots',
              path: 'unexplained',
            },
          },
          // Pure synthesis over what the render pass reported: a summary that
          // could re-read the film could also disagree with the pass it is
          // summarising.
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: { operations: [], integrations: [] },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['headline', 'rendered', 'keyframedOnly', 'unrendered', 'unexplained'],
              additionalProperties: false,
              properties: {
                headline: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                  description:
                    'What the pass produced, in a sentence an operator can act on — including whether the film is now watchable in sequence.',
                },
                rendered: {
                  type: 'array',
                  maxItems: 200,
                  description: 'One entry per shot that came back with a take.',
                  items: {
                    type: 'object',
                    required: ['shotId', 'note'],
                    additionalProperties: false,
                    properties: {
                      shotId: { type: 'string', minLength: 1, maxLength: 27 },
                      note: { type: 'string', maxLength: 400 },
                      costUsd: {
                        type: 'number',
                        minimum: 0,
                        description:
                          'What the shot cost across every render it took. Omitted — never zero — when no figure was reported.',
                      },
                    },
                  },
                },
                keyframedOnly: {
                  type: 'array',
                  maxItems: 200,
                  description:
                    'Carried through from the pass: one entry per shot whose keyframe was bought and whose clip was not.',
                  items: {
                    type: 'object',
                    required: ['shotId', 'reason'],
                    additionalProperties: false,
                    properties: {
                      shotId: { type: 'string', minLength: 1, maxLength: 27 },
                      reason: { type: 'string', minLength: 1, maxLength: 800 },
                      costUsd: {
                        type: 'number',
                        minimum: 0,
                        description:
                          'What the keyframe render reported it cost. Omitted, never zero, when no figure was reported.',
                      },
                    },
                  },
                },
                unrendered: {
                  type: 'array',
                  maxItems: 200,
                  description:
                    'One entry per shot that owed a take and did not get one, carrying the refusal in its own words.',
                  items: {
                    type: 'object',
                    required: ['shotId', 'reason'],
                    additionalProperties: false,
                    properties: {
                      shotId: { type: 'string', minLength: 1, maxLength: 27 },
                      reason: { type: 'string', minLength: 1, maxLength: 800 },
                    },
                  },
                },
                unexplained: {
                  type: 'integer',
                  minimum: 0,
                  description:
                    'Carried through from the pass: shots that owed a take and ended with neither one nor a reason. Zero is a pass that accounted for everything it touched — including a pass that rendered nothing because nothing owed a take.',
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
          name: 'Pass headline',
          description: 'What this pass produced, and whether the film is watchable in sequence.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'unexplained',
          name: 'Shots left unexplained',
          description:
            'How many shots owed a take and ended the pass with neither one nor a stated reason.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'unrendered',
          name: 'Shots left unrendered',
          description: 'The shots that owed a take and did not get one, each with its refusal.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'keyframedOnly',
          name: 'Shots holding a still and no clip',
          description: 'The shots whose keyframe was bought while their clip was not.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'headline',
        guidance:
          'The film itself is the deliverable — the takes were recorded onto its shots, not returned here. Relay the headline and, when shots went unrendered, their reasons verbatim: those name what the operator has to edit. Report the spend honestly, including renders that reported no cost.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'film-shot-batch',
      name: 'Render Film Shots',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'takes-traceable',
            description:
              'Every take recorded by the pass carries the recipe it was actually rendered from, so the film’s own drift reading stays true.',
          },
          {
            id: 'no-rerolls',
            description:
              'No shot whose take was already current was rendered again — the pass spends only on shots that owed one.',
          },
          {
            id: 'refusals-carried',
            description:
              'Every shot left unrendered is reported with the refusal in its own words, so the operator learns what to change.',
          },
        ],
      },
      mode: 'process' as const,
    },
    evalSuite: {
      goalCriteria: [],
      taskCriteria: {
        'summarise-pass': [
          {
            name: 'pass-reports-a-headline',
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
        'render the shots',
        'generate the film',
        'produce the shots',
        'render the film',
        'make the takes',
      ],
      activationHint:
        'One run produces ONE film: the required inputs are the film applet instance id and maxShots — the operator’s spend ceiling stated in shots — plus an optional note narrowing the pass. It renders only the shots that owe a take — a shot whose take already matches its recipe is left alone — records each take against the recipe it was rendered from, and reports what the pass spent. Shots it could not render come back with the refusal in their own words, naming what to edit.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'The batch is one agent task rather than a task per shot because a workflow graph is static and a film has as many shots as it has — the loop lives in the one place a loop can live, and the graph stays a fixed two-task line. What the pass may do is bounded by that task\u2019s capability list rather than by its prompt: it reads the applet, renders, and records, and it cannot write to Memory because a render files its own bytes and returns the pinned reference a take is recorded against. Traceability is structural — the applet checks a take\u2019s provenance against the live shot and refuses one whose recipe has already moved, so a recorded take was rendered from the shot it claims. The rules a render must satisfy are not restated here: the operation, the capability descriptor and the provider each refuse what they cannot deliver, naming what to fix, and the summary carries those refusals verbatim rather than collapsing them into a failure count.',
  },
};

export { FILM_SHOT_BATCH };
