import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  SimulationBaselineSchema,
  SimulationCallRecordSchema,
  SimulationCollectionSchema,
  SimulationReadinessReportSchema,
  SimulationRunContextSchema,
  SimulationSchema,
  SimulationTargetSchema,
} from '../simulation/index.js';

/**
 * The artifact carries cross-field refinements — effects may only name declared
 * collections, profile ids must be unique — so its field shape is reached
 * through `innerType()`. Projections pick from there and stay a view of the
 * contract instead of a second copy of it.
 */
const SimulationFields = SimulationSchema.innerType();

const SimulationIdSchema = SimulationBaselineSchema.shape.simulationId;
const BaselineVersionSchema = SimulationBaselineSchema.shape.version;
const WorldVersionSchema = SimulationCallRecordSchema.shape.worldVersionAfter;
const CollectionNameSchema = SimulationCollectionSchema.shape.collection;
const BindingIdSchema = SimulationCallRecordSchema.shape.bindingId;
const RunIdSchema = z.string().uuid();

/** The readiness roll-up without the per-endpoint detail a list view never renders. */
export const SimulationReadinessSummarySchema = SimulationReadinessReportSchema.omit({
  endpoints: true,
  diagnostics: true,
});
export type SimulationReadinessSummary = z.infer<typeof SimulationReadinessSummarySchema>;

export const SimulationSummarySchema = SimulationFields.pick({
  simulationId: true,
  revision: true,
  name: true,
  description: true,
  targets: true,
}).extend({
  readiness: SimulationReadinessSummarySchema,
  baselineVersions: z.array(BaselineVersionSchema),
});
export type SimulationSummary = z.infer<typeof SimulationSummarySchema>;

// ============================================================================
// integration.simulation.list
// ============================================================================

export const SimulationListInputSchema = z.object({
  integrationId: SimulationTargetSchema.shape.integrationId
    .optional()
    .describe('Restrict to simulations targeting one API definition. Omit for all.'),
});
export type SimulationListInput = z.infer<typeof SimulationListInputSchema>;

export const SimulationListOutputSchema = z.object({
  items: z.array(SimulationSummarySchema),
  total: z.number().int().min(0),
});
export type SimulationListOutput = z.infer<typeof SimulationListOutputSchema>;

// ============================================================================
// integration.simulation.get
// ============================================================================

export const SimulationGetInputSchema = z.object({
  simulationId: SimulationIdSchema,
});
export type SimulationGetInput = z.infer<typeof SimulationGetInputSchema>;

export const SimulationGetOutputSchema = z.object({
  simulation: SimulationSchema,
  readiness: SimulationReadinessReportSchema,
  baselines: z.array(SimulationBaselineSchema),
});
export type SimulationGetOutput = z.infer<typeof SimulationGetOutputSchema>;

// ============================================================================
// integration.simulation.upsert
// ============================================================================

export const SimulationUpsertInputSchema = z.object({
  simulation: SimulationSchema,
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .describe(
      'The revision you read before merging, or 0 to create. Required, not optional: this replaces the whole artifact, so two authors who each read revision N would both store N+1 and the second would silently drop the first. Send the `revision` from your `integration.simulation.get`.',
    ),
});
export type SimulationUpsertInput = z.infer<typeof SimulationUpsertInputSchema>;

export const SimulationUpsertOutputSchema = z.object({
  simulationId: SimulationIdSchema,
  revision: SimulationFields.shape.revision,
  created: z.boolean(),
  readiness: SimulationReadinessReportSchema,
});
export type SimulationUpsertOutput = z.infer<typeof SimulationUpsertOutputSchema>;

// ============================================================================
// integration.simulation.delete
// ============================================================================

export const SimulationDeleteInputSchema = z.object({
  simulationId: SimulationIdSchema,
});
export type SimulationDeleteInput = z.infer<typeof SimulationDeleteInputSchema>;

export const SimulationDeleteOutputSchema = z.object({
  simulationId: SimulationIdSchema,
  deleted: z.boolean(),
  /** Bindings left declaring simulated fulfillment against the removed simulation. */
  orphanedBindingIds: z.array(BindingIdSchema),
});
export type SimulationDeleteOutput = z.infer<typeof SimulationDeleteOutputSchema>;

// ============================================================================
// integration.simulation.seed
// ============================================================================

export const SimulationSeedInputSchema = z.object({
  simulationId: SimulationIdSchema,
  baselineVersion: BaselineVersionSchema.optional().describe(
    'Asserts the version this seed is about to mint, which is always one past the latest — a baseline version is immutable, because a run pins one for its lifetime. Omit it unless you are guarding against a concurrent write.',
  ),
  description: SimulationBaselineSchema.shape.description,
  entities: z
    .record(CollectionNameSchema, z.array(z.record(z.string(), z.unknown())).max(5000))
    .describe(
      'Entities per declared collection, replacing that collection wholesale in the newly minted version. Collections left out are carried forward from the previous version and held to the declarations as they stand now, so one whose schema or identity field changed since it was seeded has to be supplied again; one the simulation no longer declares is not carried. A collection the simulation does not declare, or an entity failing its collection schema, rejects the whole request.',
    ),
});
export type SimulationSeedInput = z.infer<typeof SimulationSeedInputSchema>;

export const SimulationSeedOutputSchema = z.object({
  baseline: SimulationBaselineSchema,
});
export type SimulationSeedOutput = z.infer<typeof SimulationSeedOutputSchema>;

// ============================================================================
// integration.simulation.freeze
// ============================================================================

export const SimulationFreezeInputSchema = z.object({
  simulationId: SimulationIdSchema,
  runId: RunIdSchema.describe('The run whose journal folds into the new baseline.'),
  expectedVersion: BaselineVersionSchema.describe(
    'The baseline version being promoted from — the run’s pinned `baselineVersion`. The write conflicts when another freeze already promoted from it.',
  ),
  description: SimulationBaselineSchema.shape.description,
});
export type SimulationFreezeInput = z.infer<typeof SimulationFreezeInputSchema>;

export const SimulationFreezeOutputSchema = z.object({
  baseline: SimulationBaselineSchema,
  /** Journal records folded into the promoted world. */
  foldedCallCount: z.number().int().min(0),
  worldVersion: WorldVersionSchema,
});
export type SimulationFreezeOutput = z.infer<typeof SimulationFreezeOutputSchema>;

// ============================================================================
// integration.simulation.inspect
// ============================================================================

export const SimulationInspectInputSchema = z.object({
  simulationId: SimulationIdSchema,
  runId: RunIdSchema,
  worldVersion: WorldVersionSchema.optional().describe(
    'Fold the journal to this version. Omit for the run’s head. A call record’s `worldVersionBefore` reconstructs exactly what that call read.',
  ),
  collections: z
    .array(CollectionNameSchema)
    .max(64)
    .optional()
    .describe('Restrict the returned world to these collections. Omit for all.'),
  entityLimit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Cap on entities returned per collection.'),
  includeCalls: z
    .boolean()
    .optional()
    .describe('Also return the journal records up to `worldVersion`.'),
});
export type SimulationInspectInput = z.infer<typeof SimulationInspectInputSchema>;

const SimulationWorldCollectionSchema = z.object({
  collection: CollectionNameSchema,
  entities: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().min(0),
  truncated: z.boolean(),
});

export const SimulationInspectOutputSchema = z.object({
  runContext: SimulationRunContextSchema,
  worldVersion: WorldVersionSchema,
  /** False when an earlier version was reconstructed rather than the current head. */
  atHead: z.boolean(),
  collections: z.array(SimulationWorldCollectionSchema),
  calls: z.array(SimulationCallRecordSchema).optional(),
});
export type SimulationInspectOutput = z.infer<typeof SimulationInspectOutputSchema>;

// ============================================================================
// Registrations
// ============================================================================

export const SimulationOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'integration',
    group: 'simulation',
    verb: 'list',
    name: 'List Simulations',
    actionLabel: 'Listing simulations…',
    groupDisplayName: 'Simulations',
    groupDescription:
      'Author and inspect the simulations that fulfill an API definition without a network.',
    semanticDescription:
      'Inventory of the simulations in this space. Each carries the API definition it targets, its revision, its baseline versions, and a readiness roll-up counting how many of that definition’s endpoints are world-ready, contract-ready, or not ready. Readiness is recomputed on every read, never stamped, so the counts describe the simulation as it stands now.',
    tags: ['integration', 'simulation', 'registry'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'List this space’s simulations with the API each targets and an endpoint readiness roll-up.',
      whenToUse: [
        'Finding which APIs this space can already exercise without a live host',
        'Checking coverage before designing an agent against an API that does not exist yet',
      ],
      whenNotToUse: [
        'Reading one simulation’s per-endpoint readiness and diagnostics — use integration.simulation.get',
        'Checking whether a vendor is bound at all — use integration.registry.lookup',
      ],
      pitfalls: [
        'The roll-up counts endpoints, not calls: one not-ready endpoint leaves every sibling endpoint usable.',
      ],
      minimalExampleInput: {},
      followUp: [
        {
          operationId: 'integration.simulation.get',
          note: 'Read one simulation in full, with per-endpoint readiness and diagnostics.',
        },
      ],
    },
    accessMode: 'read',
    inputZod: SimulationListInputSchema,
    outputZod: SimulationListOutputSchema,
  },
  {
    stepType: 'integration',
    group: 'simulation',
    verb: 'get',
    name: 'Get Simulation',
    actionLabel: 'Fetching simulation…',
    semanticDescription:
      'Read one simulation in full — persona, collections, rule profiles, per-endpoint world effects and policy — together with its recomputed readiness report and its baseline versions. The report names, per endpoint, which status classes it can answer, whether it holds a world effect, and a structured diagnostic for every gap.',
    tags: ['integration', 'simulation'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Read one simulation with its per-endpoint readiness report and baseline versions.',
      whenToUse: [
        'Diagnosing why a simulated endpoint refuses a call',
        'Reading the current artifact before editing it through integration.simulation.upsert',
      ],
      whenNotToUse: [
        'Browsing what exists — use integration.simulation.list',
        'Reading the world a run actually produced — use integration.simulation.inspect',
      ],
      pitfalls: [
        'A contract_ready endpoint answers from rules and schema examples only; its first stateful call fails until a WorldEffect is declared for it.',
        'Readiness is recomputed at read, so a report quoted from an earlier turn can already be stale.',
      ],
      minimalExampleInput: { simulationId: 'billing-sim' },
      followUp: [
        {
          operationId: 'integration.simulation.upsert',
          note: 'Edit the artifact — send the whole simulation, not a patch.',
        },
      ],
    },
    accessMode: 'read',
    inputZod: SimulationGetInputSchema,
    outputZod: SimulationGetOutputSchema,
  },
  {
    stepType: 'integration',
    group: 'simulation',
    verb: 'upsert',
    name: 'Upsert Simulation',
    actionLabel: 'Saving simulation…',
    semanticDescription:
      'Create or replace a simulation. The whole artifact is sent and stored; `revision` is assigned by the store, which bumps it on every write. A run pins the revision it started on, so editing rules, collections or effects never moves the world under a running agent. The simulation must target an endpoint-mode API definition that exists in this space.',
    tags: ['integration', 'simulation', 'crud'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Create or replace a simulation artifact; the store assigns the revision it bumps on write.',
      whenToUse: [
        'Describing the API you wish existed so an agent can be built against it now',
        'Adding a rule profile, collection or world effect to an existing simulation',
      ],
      whenNotToUse: [
        'Loading seed entities — use integration.simulation.seed',
        'Turning a warm run’s world into fixed seed data — use integration.simulation.freeze',
      ],
      pitfalls: [
        "This replaces the artifact rather than patching it — read it with integration.simulation.get first and send the merged whole, passing that read's `revision` as `expectedRevision` so a concurrent edit is refused instead of silently overwritten.",
        'Settle who the world has, and what it is, BEFORE declaring collections. Every collection must state `ownership`, and `persona_scoped` needs a `personaField` the entity schema actually carries — so deciding personas after writing schemas means revising every one of them. `domainBrief` has the same dependency in the other direction: it is what generation reads to invent coherent entities, and one written afterwards cannot improve the answers already given.',
        'A world effect may only name a collection declared in `collections`, and `targets.integrationId` must be the API a binding will point at; a mismatch is rejected at write.',
        'Only an endpoint-mode API definition can be simulated — a direct_url definition declares no endpoints, so there is no contract to answer with.',
        'Declaring a collection is not the same as answering with it. An endpoint with no `effects` or `handlers` entry is answered by a model on every call, however much seed data the collection holds — check `readiness.endpoints[].readiness` for `world_ready` rather than assuming the world is reached.',
        'An `effects` entry cannot compute — it selects entities, copies request fragments and assigns literals, and `now` is its only expression. Anything needing arithmetic, aggregation, a conditional or a date offset belongs in `handlers`, which is a function and is tried first.',
      ],
      // A COMPLETE small artifact rather than the three required fields.
      // What is hard here is the world effect — reads bind request paths to
      // entity paths, writes name a collection and an identity, and the
      // projection says what the response body is built from. An example
      // showing only the identifiers teaches none of that, and an author who
      // stops at collections ships a world nothing reads.
      minimalExampleInput: {
        expectedRevision: 0,
        simulation: {
          simulationId: 'billing-sim',
          name: 'Billing API',
          targets: { sourceKind: 'api', integrationId: 'billing' },
          domainBrief: 'A subscription billing service. Amounts are in cents, USD.',
          personas: [{ personaId: 'cus_1', label: 'Ada Lovelace' }],
          defaultPersonaId: 'cus_1',
          disclosePersona: true,
          collections: [
            {
              collection: 'invoices',
              identityField: 'invoiceId',
              // Rows belong to a caller: every read is narrowed to the acting
              // persona and every write stamped with it. `shared` is the other
              // choice, and one of the two must be stated.
              ownership: 'persona_scoped',
              personaField: 'customerId',
              schema: {
                type: 'object',
                required: ['invoiceId', 'customerId', 'amountCents', 'status'],
                properties: {
                  invoiceId: { type: 'string' },
                  customerId: { type: 'string' },
                  amountCents: { type: 'number' },
                  status: { type: 'string' },
                },
              },
            },
          ],
          handlers: {
            // The rung for anything a declarative effect cannot express:
            // arithmetic, aggregation, a conditional, a date offset. Note the
            // id — `newId` is what lets the response name the row it created.
            payInvoiceWithFee: {
              collections: ['invoices'],
              code: [
                'var invoice = world.invoices.find(function (i) { return i.invoiceId === request.body.invoiceId; });',
                "if (!invoice) return { status: 404, body: { error: 'No invoice with that id.' } };",
                "if (invoice.status === 'paid') return { status: 409, body: { error: 'Already paid.' } };",
                'var fee = invoice.amountCents > 100000 ? 0 : 250;',
                'return {',
                '  status: 200,',
                '  body: { invoiceId: invoice.invoiceId, chargedCents: invoice.amountCents + fee, feeCents: fee },',
                '  mutations: [',
                "    { collection: 'invoices', op: 'update', entityId: invoice.invoiceId,",
                "      body: { status: 'paid', paidAt: new Date(now).toISOString() } },",
                '  ],',
                '};',
              ].join('\n'),
            },
          },
          effects: {
            // Reads the caller's invoices. It names no customer: the store
            // narrows to the acting persona, exactly as a real API would.
            listInvoices: {
              reads: [{ collection: 'invoices', select: [], cardinality: 'many', as: 'invoices' }],
              writes: [],
              project: [{ bodyPath: '/', from: { read: 'invoices' }, fields: [] }],
              status: 200,
            },
            // Reads one by id, writes a status change, and answers with the
            // row it wrote — not the one it read.
            payInvoice: {
              reads: [
                {
                  collection: 'invoices',
                  select: [{ entityPath: '/invoiceId', requestPath: '/body/invoiceId' }],
                  cardinality: 'one',
                  onMissing: { respond: 404, body: { error: 'No invoice with that id.' } },
                  as: 'invoice',
                },
              ],
              writes: [
                {
                  collection: 'invoices',
                  op: 'update',
                  identity: 'invoiceId',
                  // An update applies to the entities a READ found, named
                  // here. Without it there is nothing to update — the write
                  // would resolve against an empty set and change nothing.
                  targetRead: 'invoice',
                  assign: { status: 'paid', paidAt: 'now' },
                  as: 'paid',
                },
              ],
              project: [{ bodyPath: '/', from: { write: 'paid' }, fields: [] }],
              status: 200,
            },
          },
        },
      },
      followUp: [
        {
          operationId: 'integration.simulation.get',
          note: 'Re-read the readiness report to see which endpoints the edit made answerable.',
        },
      ],
    },
    accessMode: 'write',
    inputZod: SimulationUpsertInputSchema,
    outputZod: SimulationUpsertOutputSchema,
  },
  {
    stepType: 'integration',
    group: 'simulation',
    verb: 'delete',
    name: 'Delete Simulation',
    actionLabel: 'Deleting simulation…',
    semanticDescription:
      'Delete a simulation with its baselines, run journals, run pins and the payload objects those pointed at. Bindings that declare simulated fulfillment against it are returned as `orphanedBindingIds` — they stop resolving until they are repointed or set back to live fulfillment.',
    tags: ['integration', 'simulation', 'crud'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete a simulation with its baselines, run journals and run pins.',
      whenToUse: ['Removing a simulation nothing is bound to any more'],
      whenNotToUse: [
        'The real API has shipped — flip the binding’s fulfillment to live and keep the simulation for evals',
      ],
      pitfalls: [
        'A binding still declaring simulated fulfillment against this simulation stops resolving; repoint it or set it live first.',
        'Baselines, journals and run pins go with it, so recorded worlds and decision-time inspection for past runs are lost.',
      ],
      minimalExampleInput: { simulationId: 'billing-sim' },
    },
    accessMode: 'write',
    inputZod: SimulationDeleteInputSchema,
    outputZod: SimulationDeleteOutputSchema,
  },
  {
    stepType: 'integration',
    group: 'simulation',
    verb: 'seed',
    name: 'Seed Simulation Baseline',
    actionLabel: 'Seeding simulation baseline…',
    semanticDescription:
      'Mint a new baseline version from supplied JSON, one array per declared collection. The previous version is copied forward and the supplied collections replace their contents in the copy, so a baseline version is never rewritten — runs pin one for their lifetime. Every entity is validated against its collection schema and every collection against the simulation’s declarations; a single failure rejects the whole request rather than storing a partial world.',
    tags: ['integration', 'simulation', 'baseline'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Mint a baseline version from supplied JSON, copied forward from the previous one.',
      whenToUse: [
        'Importing a hand-written or exported seed world into a simulation',
        'Giving rung-2 reads real entities to traverse instead of generated ones',
      ],
      whenNotToUse: [
        'Capturing a world a run already produced — use integration.simulation.freeze',
        'Changing collection schemas or effects — use integration.simulation.upsert',
      ],
      pitfalls: [
        'Every seed mints a new version; an existing one can never be written to, so runs and bindings keep reading the version they pinned until they are pointed at the new one.',
        'A collection the simulation does not declare, or one entity failing its collection schema, rejects the entire payload.',
        'Collections absent from `entities` are copied from the previous version — this replaces per collection, not the whole world.',
      ],
      minimalExampleInput: {
        simulationId: 'billing-sim',
        entities: { customers: [{ customerId: 'cus_1', balanceCents: 4000 }] },
      },
    },
    accessMode: 'write',
    inputZod: SimulationSeedInputSchema,
    outputZod: SimulationSeedOutputSchema,
  },
  {
    stepType: 'integration',
    group: 'simulation',
    verb: 'freeze',
    name: 'Freeze Simulation Baseline',
    actionLabel: 'Freezing simulation baseline…',
    semanticDescription:
      'Fold a run’s journal onto the baseline it was pinned to and promote the result as a new baseline version. Everything the run read, wrote or invented becomes fixed seed data, so the simulation converges from generative to deterministic. The promotion takes optimistic concurrency on `expectedVersion`: a conflicting freeze fails rather than overwriting.',
    tags: ['integration', 'simulation', 'baseline', 'determinism'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Promote a run’s folded world into a new baseline version, pinned by expectedVersion.',
      whenToUse: [
        'Turning an exploratory run’s invented world into fixed, free, reproducible seed data',
        'Preparing a simulation for grading, where generated responses are not reproducible',
      ],
      whenNotToUse: [
        'Loading a world authored outside the platform — use integration.simulation.seed',
        'Reading a past world without promoting it — use integration.simulation.inspect',
      ],
      pitfalls: [
        'Freezing removes data variance and nothing else. A frozen world is not a regression suite: grading additionally needs `policy.unmatched: "error"`, a pinned rule profile and definition, and assertions.',
        'Fold a run that has finished — a journal still growing yields an arbitrary midpoint.',
        'A run that never made a simulated call through this simulation has no pinned world, and freezing it is refused rather than promoting a clone of the baseline.',
        'On an expectedVersion mismatch another freeze already promoted from that version; re-read with integration.simulation.get and retry against the current one.',
      ],
      minimalExampleInput: {
        simulationId: 'billing-sim',
        runId: '9a3e0000-0000-4000-8000-000000000001',
        expectedVersion: 1,
      },
    },
    accessMode: 'write',
    inputZod: SimulationFreezeInputSchema,
    outputZod: SimulationFreezeOutputSchema,
  },
  {
    stepType: 'integration',
    group: 'simulation',
    verb: 'inspect',
    name: 'Inspect Simulated World',
    actionLabel: 'Inspecting simulated world…',
    semanticDescription:
      'Fold a run’s simulation journal to a world version and return the world as it stood at that point. The journal is the source of truth and every call record carries the world version before and after it, so passing a call’s `worldVersionBefore` reconstructs exactly what the agent read when it made that decision.',
    tags: ['integration', 'simulation', 'inspection'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Reconstruct the world a run saw at a given world version, folded from its journal.',
      whenToUse: [
        'Explaining a decision an agent made against a simulated tool result',
        'Checking what a run’s world holds before freezing it into a baseline',
      ],
      whenNotToUse: [
        'Reading the simulation’s authored artifact — use integration.simulation.get',
        'Promoting the world into seed data — use integration.simulation.freeze',
      ],
      pitfalls: [
        'A version older than the head is reconstructed by folding the journal, not read back from the materialized head, so restricting `collections` and `entityLimit` keeps the response bounded.',
        'A worldVersion past the run’s head fails rather than clamping to the head.',
      ],
      minimalExampleInput: {
        simulationId: 'billing-sim',
        runId: '9a3e0000-0000-4000-8000-000000000001',
      },
      followUp: [
        {
          operationId: 'integration.simulation.freeze',
          note: 'Promote the folded world into a new baseline version.',
        },
      ],
    },
    accessMode: 'read',
    inputZod: SimulationInspectInputSchema,
    outputZod: SimulationInspectOutputSchema,
  },
];
