import { z } from 'zod';
import { SimulationCodeHandlerSchema } from './codeHandler.js';
import { SimulationRuleSchema } from './rule.js';
import { WorldEffectSchema } from './worldEffect.js';

/**
 * A Simulation fulfills an API definition's contract without a network.
 *
 * It targets the DEFINITION rather than a binding, so one simulation can back
 * a demo binding and a CI binding; each run's world is separate regardless.
 * API only — no MCP binding can consume a simulation, so admitting an MCP
 * target would put a value in the artifact that nothing can resolve.
 */

export const SimulationCollectionSchema = z.object({
  collection: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  /** Entity field carrying identity. Minted from the run seed when generated. */
  identityField: z.string().min(1).max(128),
  /**
   * Whether rows here belong to a caller, stated rather than inferred.
   *
   * A real API takes the caller's identity from the credential, never from the
   * request — so an agent asking for "my purchases" sends no customer id and
   * receives only its own. `persona_scoped` reproduces that: every read is
   * narrowed to the run's persona and every write is stamped with it, so an
   * endpoint cannot return or create another persona's rows even when its
   * effect asks for all of them.
   *
   * REQUIRED, and that is the point. This was inferred from the presence of
   * `personaField`, which made forgetting the field mean "shared" — a
   * cross-customer collection produced by an omission, reading correctly and
   * leaking silently. An author now has to say which kind of data this is.
   */
  ownership: z.enum(['shared', 'persona_scoped']),
  /** The field naming the owner. Required for `persona_scoped`, absent otherwise. */
  personaField: z.string().min(1).max(128).optional(),
  /** JSON Schema every entity in the collection validates against. */
  schema: z.record(z.string(), z.unknown()),
});
export type SimulationCollection = z.infer<typeof SimulationCollectionSchema>;

/**
 * Who a run is acting as.
 *
 * `personaId` is the VALUE stored in each scoped collection's `personaField`,
 * not a separate key to map — one identity, one spelling, so a persona that
 * owns no rows is visibly empty rather than silently mis-joined.
 */
export const SimulationPersonaSchema = z.object({
  personaId: z.string().min(1).max(128),
  label: z.string().max(256).optional(),
  /**
   * What is true of this persona specifically, read alongside the domain brief
   * on a generated call. The brief describes the world; this describes whose
   * corner of it the caller is standing in.
   *
   * GENERATOR-FACING ONLY, and deliberately absent from `DisclosedCallerSchema`.
   * A brief states account facts — a refund in flight, a missed payment — and an
   * agent handed those can answer from them without calling anything, passing a
   * scenario it never exercised. The generator needs the whole picture; the
   * caller's session carries none of it.
   */
  brief: z.string().max(2000).optional(),
});
export type SimulationPersona = z.infer<typeof SimulationPersonaSchema>;

/**
 * The caller as the AGENT is told about them, when a run discloses.
 *
 * A separate type rather than a projection written at each call site, because
 * "the brief never reaches the agent" has to be a property of the shape. Add a
 * field here and every disclosure carries it; the only way to leak the brief is
 * to name it.
 *
 * Identity only, and deliberately closed. An open bag of "session context"
 * stood here and was removed: it is arbitrary JSON rendered straight into the
 * agent's context, which is a path for scenario facts — or instructions — to
 * reach the agent without passing through the simulated API at all. Both
 * agent-authored simulations filled it with the caller's name and id, which
 * `label` and `personaId` already carry. Concrete typed fields can be added
 * when a product surface actually needs one.
 */
export const DisclosedCallerSchema = z.object({
  personaId: z.string().min(1).max(128),
  label: z.string().max(256).optional(),
});
export type DisclosedCaller = z.infer<typeof DisclosedCallerSchema>;

/**
 * The persona a run acts as, resolved from its input and the simulation's default.
 *
 * ONE resolution for both readers — the world's pin, which scopes every row the
 * run can see, and the disclosure that tells the agent who it is. Two copies
 * drift into a run told it is Amara while every row it reads belongs to Tomas:
 * an agent reporting the wrong person's account with total confidence, and a
 * transcript in which nothing looks wrong.
 *
 * `undefined` takes the simulation's default; an explicit `null` acts as
 * nobody, which is the unauthenticated caller.
 */
export function actingPersonaId(
  simulation: Pick<Simulation, 'simulationId' | 'defaultPersonaId'>,
  runInput?: { personaIds?: Record<string, string | null> | undefined } | null,
): string | null {
  const requested = runInput?.personaIds?.[simulation.simulationId];
  if (requested !== undefined) return requested;
  return simulation.defaultPersonaId ?? null;
}

/**
 * One disclosed identity, named by the integration it belongs to.
 *
 * `integrationId` names a CONTRACT, never a fulfillment — a caller of
 * `bnpl-core` is what a live deployment would call itself too.
 */
export const DisclosedCallerBindingSchema = z.object({
  integrationId: z.string().min(1).max(128),
  caller: DisclosedCallerSchema,
});
export type DisclosedCallerBinding = z.infer<typeof DisclosedCallerBindingSchema>;

/**
 * Project a persona down to what a session would carry.
 *
 * The single writer of a `DisclosedCaller`. Everything it does not copy stays
 * with the generator, so a persona field added later is withheld by default
 * rather than disclosed by default.
 */
export function discloseCaller(persona: SimulationPersona): DisclosedCaller {
  return {
    personaId: persona.personaId,
    ...(persona.label !== undefined ? { label: persona.label } : {}),
  };
}

/**
 * What the model may invent when no rule matches and the world lacks the
 * entities an effect reads.
 *
 * `error` disables generation entirely: an unmatched call fails with
 * SIMULATION_UNMATCHED naming the endpoint and arguments, which is a test
 * result rather than a plausible fabrication.
 */
export const SimulationUnmatchedPolicySchema = z.enum(['generate', 'error']);
export type SimulationUnmatchedPolicy = z.infer<typeof SimulationUnmatchedPolicySchema>;

export const SimulationPolicySchema = z.object({
  unmatched: SimulationUnmatchedPolicySchema.default('generate'),
  /** Ceiling on generated calls per run. Operator-set; generation costs real tokens. */
  maxGeneratedCallsPerRun: z.number().int().min(0).max(500).default(50),
});
export type SimulationPolicy = z.infer<typeof SimulationPolicySchema>;

export const SimulationTargetSchema = z.object({
  /** API only until MCP simulation is defined — nothing else can consume one. */
  sourceKind: z.literal('api'),
  integrationId: z.string().min(1).max(128),
});
export type SimulationTarget = z.infer<typeof SimulationTargetSchema>;

export const SimulationSchema = z
  .object({
    simulationId: z.string().min(1).max(128),
    /** Bumped on every write. Pinned per run so a mid-run edit cannot move the world. */
    revision: z.number().int().min(1).default(1),
    name: z.string().min(1).max(256),
    description: z.string().max(2000).optional(),
    targets: SimulationTargetSchema,
    /** The world's character, which every generated answer has to be plausible in. */
    domainBrief: z.string().max(4000).default(''),
    /** The identities a run may act as. Empty means the world is not owned. */
    personas: z.array(SimulationPersonaSchema).max(64).default([]),
    /**
     * The persona a run acts as when it names none. Absent means none, which
     * reads every persona-scoped collection empty — the unauthenticated case.
     */
    defaultPersonaId: z.string().min(1).max(128).optional(),
    /**
     * Whether the agent is told who it is acting as, or has to find out.
     *
     * A property of the surface being simulated, not of the world: an assistant
     * embedded in an authenticated app receives the caller in its session, and
     * one that opens by asking for a customer id is rehearsing a conversation
     * that deployment never has. A phone desk is the opposite, and "verify who
     * you are talking to" is a scenario worth being able to test — so a run may
     * override this either way.
     *
     * Default false: disclosure is a deliberate claim about the deployment, and
     * one made silently for every existing simulation would be a claim nobody
     * made. Never discloses that the binding is SIMULATED — only who is calling.
     */
    disclosePersona: z.boolean().default(false),
    /**
     * The model the generative rung answers through, when this simulation
     * wants a particular one.
     *
     * Naming one PINS it: a call this space cannot resolve a credential for
     * fails rather than quietly answering from another model. Substitution
     * would record the run as having used a model that never saw the request,
     * and two runs meant to be compared would differ for a reason neither
     * transcript shows. Absent means "whatever the space would use anyway",
     * which still falls back and still always answers.
     *
     * Declared on the artifact because generation quality is a property of the
     * simulation — a world with subtle invariants needs a model that keeps
     * them. A RUN may override it (`SimulationRunInput.generationModels`),
     * which is how one scenario is replayed against several models and their
     * answers compared.
     */
    generationModel: z.string().min(1).max(128).optional(),
    collections: z.array(SimulationCollectionSchema).max(64).default([]),
    /**
     * Ordered rules, tried before any world effect. First match answers.
     *
     * A flat list rather than named selectable profiles: the plural
     * abstraction shipped with no simulation using it, and an ordered list
     * carries the whole capability — a controlled 404, a 429, a fixed response
     * an eval depends on. Named profiles come back if the eval runner ever
     * needs to choose between two without editing the artifact.
     */
    rules: z.array(SimulationRuleSchema).max(200).default([]),
    /**
     * Per-endpoint code handler, tried before the declarative effect.
     *
     * Above effects because it is the more specific authoring: an endpoint with
     * both has been given a function deliberately, and the effect it also
     * carries is the shape the function replaced.
     */
    handlers: z.record(z.string(), SimulationCodeHandlerSchema).default({}),
    /** Per-endpoint world effect. An endpoint absent here is contract-ready only. */
    effects: z.record(z.string(), WorldEffectSchema).default({}),
    policy: SimulationPolicySchema.default({}),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .superRefine((sim, ctx) => {
    const collectionNames = sim.collections.map((c) => c.collection);
    const collections = new Set(collectionNames);
    if (collections.size !== collectionNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collections'],
        message:
          'collections[].collection must be unique. Two declarations of one name give that collection two identity fields and two schemas, and every reader keys them by name, so the later declaration silently wins.',
      });
    }
    for (const [index, collection] of sim.collections.entries()) {
      if (collection.ownership === 'persona_scoped' && collection.personaField === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['collections', index, 'personaField'],
          message: `Collection "${collection.collection}" is persona_scoped but names no personaField, so nothing says which field holds the owner. Name the field, or declare the collection shared.`,
        });
      }
      if (collection.ownership === 'shared' && collection.personaField !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['collections', index, 'ownership'],
          message: `Collection "${collection.collection}" declares personaField "${collection.personaField}" but is marked shared, so that field would be ordinary data and every persona would read every row. Mark it persona_scoped, or drop the field.`,
        });
      }
    }
    const personaIds = sim.personas.map((persona) => persona.personaId);
    const personas = new Set(personaIds);
    if (personas.size !== personaIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['personas'],
        message:
          'personas[].personaId must be unique. Two personas sharing an id name one set of rows, so a run pinning it acts as both and neither.',
      });
    }
    if (sim.defaultPersonaId !== undefined && !personas.has(sim.defaultPersonaId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultPersonaId'],
        message: `defaultPersonaId "${sim.defaultPersonaId}" is not declared in personas[]. A run naming no persona would fall back to an identity that owns nothing, and every scoped collection would read empty.`,
      });
    }
    // A scoped collection with no persona to scope to reads empty for every
    // run, which looks like an authoring mistake because it is one.
    if (sim.personas.length === 0) {
      for (const [i, collection] of sim.collections.entries()) {
        if (collection.personaField === undefined) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['collections', i, 'personaField'],
          message: `Collection "${collection.collection}" is scoped by "${collection.personaField}", but the simulation declares no personas[], so every read of it is empty. Declare the personas its rows belong to, or drop personaField to make the collection shared.`,
        });
      }
    }
    for (const [endpointId, effect] of Object.entries(sim.effects)) {
      for (const [i, r] of effect.reads.entries()) {
        if (!collections.has(r.collection)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['effects', endpointId, 'reads', i, 'collection'],
            message: `Collection "${r.collection}" is not declared in collections[].`,
          });
        }
      }
      for (const [i, w] of effect.writes.entries()) {
        if (!collections.has(w.collection)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['effects', endpointId, 'writes', i, 'collection'],
            message: `Collection "${w.collection}" is not declared in collections[].`,
          });
        }
      }
    }
  });
export type Simulation = z.infer<typeof SimulationSchema>;

/** One version of a simulation's seed world. A run pins the version it started on. */
export const SimulationBaselineSchema = z.object({
  simulationId: z.string().min(1).max(128),
  version: z.number().int().min(1),
  description: z.string().max(500).optional(),
  /** Entity counts per collection — the cheap summary an operator surface reads. */
  entityCounts: z.record(z.string(), z.number().int().min(0)).default({}),
  createdAt: z.string().datetime().optional(),
});
export type SimulationBaseline = z.infer<typeof SimulationBaselineSchema>;
