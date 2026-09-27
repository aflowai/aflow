import { z } from 'zod';
import { PayloadRefSchema } from '../runtime/payloadRef.js';

/**
 * Everything a run's world is pinned to, persisted at the first simulated call
 * and immutable for the run's lifetime.
 *
 * Pinned per `(run, simulationId)`, never per run: two simulations answering
 * one run hold separate revisions, baselines, clocks and worlds, and a single
 * per-run context would hand the second whatever the first happened to fix.
 *
 * Editing a rule, a baseline or the API definition mid-run cannot change the
 * world underneath the agent, because execution resolves through `snapshotRef`
 * rather than through the current rows.
 */
export const SimulationRunContextSchema = z.object({
  simulationId: z.string().min(1).max(128),
  simulationRevision: z.number().int().min(1),
  baselineVersion: z.number().int().min(1),
  /**
   * The `SimulationSnapshot` this run executes — the simulation artifact and
   * the endpoint set it was resolved against, frozen at pin time. This is what
   * makes the pin load-bearing rather than descriptive: a revision number
   * names an artifact, and only the artifact can answer a call.
   */
  snapshotRef: PayloadRefSchema,
  /**
   * Hash of the resolved endpoint set, over the snapshot's own endpoints.
   * Recomputed at every resolve against both the snapshot and the currently
   * loaded definition, so a definition edited mid-run is refused rather than
   * answered against a contract the request was not shaped for.
   */
  definitionHash: z.string().min(1).max(128),
  /** Seeds id minting and rule ordinals. Defaults to a derivation of runId. */
  seed: z.string().min(1).max(128),
  /**
   * Who the run is acting as, resolved at pin time and fixed for its life.
   * `null` is an identity of nobody — every persona-scoped collection reads
   * empty, which is the unauthenticated caller.
   */
  personaId: z.string().min(1).max(128).nullable().default(null),
  /** Virtual clock anchor. `now` inside the world resolves against this, never wall-clock. */
  clockAnchorMs: z.number().int().min(0),
  /**
   * The model rung 3 answered through, pinned when the simulation or the run
   * named one. A named model is resolved or the call fails — recording a model
   * that did not answer is worse than refusing.
   */
  modelRef: z.string().min(1).max(128).optional(),
});
export type SimulationRunContext = z.infer<typeof SimulationRunContextSchema>;

/** Run-start input that pins the context. Every field is optional — absent means derived. */
export const SimulationRunInputSchema = z.object({
  seed: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Seeds entity ids. Defaults to a derivation of the run id.'),
  /**
   * Keyed by `simulationId`, because a baseline version is an opaque counter
   * per simulation and means nothing to another one. A single number applied
   * to every simulation a run touches lands on whichever minted its pin first,
   * and a version that simulation never had reads as an empty world — which,
   * under `unmatched: 'generate'`, is answered by inventing one.
   */
  baselineVersions: z
    .record(z.string().min(1).max(128), z.number().int().min(1))
    .optional()
    .describe('Which baseline world each simulation starts from, keyed by simulationId.'),
  /**
   * Who each simulation's run acts as, keyed by `simulationId`. Omitting a
   * simulation takes its `defaultPersonaId`; an explicit `null` acts as nobody.
   * Shared across simulations would be wrong for the same reason a baseline
   * version is: an identity means nothing outside the world that declares it.
   */
  personaIds: z
    .record(z.string().min(1).max(128), z.string().min(1).max(128).nullable())
    .optional()
    .describe(
      'Which persona each simulation acts as, keyed by simulationId. `null` acts as nobody — the unauthenticated caller. Omitting a simulation takes its declared default.',
    ),
  /**
   * Whether each simulation's caller is disclosed to the agent, overriding the
   * simulation's own `disclosePersona`. Keyed by `simulationId` for the same
   * reason the persona is: the answer belongs to one product surface, and a run
   * touching two simulations is standing in front of two of them.
   *
   * Omitting a simulation takes its declared setting.
   */
  disclosePersonas: z
    .record(z.string().min(1).max(128), z.boolean())
    .optional()
    .describe(
      'Whether the agent is TOLD who it is acting for, keyed by simulationId. Overrides the simulation. False makes the agent establish identity itself, which is a phone-desk scenario rather than an in-app one.',
    ),
  /**
   * The model each simulation's generative rung answers through, overriding
   * the artifact's `generationModel`. Keyed by `simulationId` like the rest.
   *
   * This is the benchmarking handle: the same pinned world, the same call
   * sequence, a different model, and the journal records which one answered
   * (`SimulationRunContext.modelRef`) so two runs are comparable rather than
   * merely different.
   */
  generationModels: z
    .record(z.string().min(1).max(128), z.string().min(1).max(128))
    .optional()
    .describe(
      'Which model answers each simulation’s generated calls, keyed by simulationId. The benchmarking handle: same world, same sequence, different model.',
    ),
  clockAnchorMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Virtual-clock anchor. `now` inside the world resolves against this.'),
});
export type SimulationRunInput = z.infer<typeof SimulationRunInputSchema>;
