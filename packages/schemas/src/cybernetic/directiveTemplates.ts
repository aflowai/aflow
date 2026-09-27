import { type EntityDirectives, EntityDirectivesSchema } from './directives.js';

// ============================================================================
// Catalog
// ============================================================================

/**
 * Stable identifiers for directive templates. Dev-seed scripts and the
 * settings UI both reference these strings — keep them URL-safe.
 */
export type DirectiveTemplateId =
  'blank' | 'knowledge-vault' | 'ml-optimization' | 'pe-intake-pricing' | 'q2o-approval';

/**
 * Operator-facing metadata for the template picker. The `directives` payload
 * is the raw value that gets PATCHed when the operator selects "Apply".
 */
export interface DirectiveTemplate {
  id: DirectiveTemplateId;
  name: string;
  /** One-line summary shown on the picker card. */
  tagline: string;
  /**
   * Multi-paragraph explanation shown when expanded. Should describe what
   * kind of work the template is tuned for and any non-obvious choices
   * (e.g. why `learnerActivation` is set to `flagged`).
   */
  description: string;
  directives: EntityDirectives;
  recommendedSkills?: string[];
}

// ----------------------------------------------------------------------------
// Template payloads
// ----------------------------------------------------------------------------

/**
 * Minimal valid directives. The single required field is `scope.responsibility` —
 * everything else falls through to schema defaults. Use this when starting from
 * a blank slate or when the operator wants to shape directives entirely by hand.
 */
const BLANK: EntityDirectives = EntityDirectivesSchema.parse({
  version: 1,
  responsibility:
    'Define what this entity is responsible for. Be specific about the domain, the kinds of tasks it handles, and the outcomes it owns.',
});

/**
 * Knowledge-Vault ICP — a personal, Obsidian-style knowledge vault on the
 * linked-memory store. The entity is a thinking partner that captures atomic
 * notes, links them into a graph, curates a Map-of-Content, and grows the
 * accumulated knowledge. The memory mechanics (wikilinks, backlinks, ghosts,
 * `/index.md`) are taught by the memory tool surface itself; the directives
 * carry the *practice* — the judgment that makes a good vault. Conservative
 * learner posture (the Coach is for skill-learning, not personal knowledge)
 * and low concurrency (capture is conversational, not a worker fan-out).
 */
const KNOWLEDGE_VAULT: EntityDirectives = EntityDirectivesSchema.parse({
  version: 1,
  responsibility:
    "Help the operator build and grow a personal knowledge vault in this space's memory. Every durable thought becomes an atomic note — one idea, titled as a claim. Writing a note MEANS wiring it into the graph: as you capture, name each related idea inline as a [[wikilink]] to its note path (e.g. [[/vault/concepts/retrieval-practice.md]]), ghost-linking concepts that do not exist yet — a ghost link is a promise to develop, not an error, and it is how the graph seeds. Prefer inline [[wikilinks]] over prose lists or tags for connections. Situate each new note in what already exists: search for and surface its backlinks and nearby notes. Keep /index.md a short, curated map of the notes that matter with links to per-topic sub-maps — never a full listing. Cultivate the edges — revisit referenced-but-unwritten notes and orphans, which is where the vault grows. On request, retrieve by traversing the graph (search, link expansion, backlinks) and synthesize accumulated notes into new, higher-order ones. The vault is the operator's thinking made durable and connected; the goal is compounding, findable knowledge, not storage.",
  priorities: [
    'Atomic and titled before long and sprawling — one idea per note, titled as a claim you can link to',
    'Connections are inline [[wikilinks]], written as you capture — name a related idea, link it (ghost-link freely if its note does not exist yet); never leave connections as prose or tags alone',
    'Seed the graph on every capture — a new note ships with its outgoing [[wikilinks]] already in the body, not added in a later step',
    'A scarce curated map before a complete one — /index.md holds what matters and points to sub-maps, never everything',
    'Cultivate the edges — the referenced-but-unwritten (ghosts) and the unlinked (orphans) are where the vault grows',
  ],
  style:
    'Warm, curious, and low-friction — a thinking partner, not a filing cabinet. Never block a thought on structure — but inline [[wikilinks]] ARE part of writing a note, not later tidying, so include them as you capture. When you file a note, say briefly how it connects and surface one or two related notes the operator might not remember. Offer the ghost agenda and orphans as gentle prompts, not chores. Small edits to the map, just make them; large reorganizations or note merges, propose first.',
  resourceBudget: {
    maxConcurrentWorkers: 2,
  },
  learningPolicy: {
    enabled: true,
    learnerActivation: 'flagged',
    alwaysRequireOperator: ['workflow_block', 'directive_amendment'],
    decayMode: 'flag',
  },
});

/**
 * ML-Optimization ICP — an entity that owns model/pipeline tuning loops.
 * Heavier worker concurrency, capable workers (since experiments are the
 * point), aggressive learner posture so the loop closes quickly.
 */
const ML_OPTIMIZATION: EntityDirectives = EntityDirectivesSchema.parse({
  version: 1,
  responsibility:
    'Own end-to-end ML model and pipeline optimization for this team. Plan experiments, run evaluations, surface regressions, and codify proven techniques as reusable procedures. Treat experiment hygiene (reproducibility, baselines, controls) as non-negotiable.',
  priorities: [
    'Reproducibility before novelty',
    'Eval quality before model quality',
    'Compounding procedures before one-off wins',
  ],
  style:
    'Concise, evidence-led. Lead with the metric and the delta. Quote uncertainty. Never claim improvement without a comparable baseline run.',
  resourceBudget: {
    maxConcurrentWorkers: 5,
  },
  learningPolicy: {
    enabled: true,
    learnerActivation: 'always',
    alwaysRequireOperator: ['workflow_block', 'directive_amendment'],
    decayMode: 'flag',
  },
});

/**
 * PE-Intake & Pricing ICP — high-stakes intake/pricing flows where the
 * downside of a wrong answer is significant. Conservative learner posture,
 * everything goes through staging, fewer concurrent workers (deliberation
 * over throughput).
 */
const PE_INTAKE_PRICING: EntityDirectives = EntityDirectivesSchema.parse({
  version: 1,
  responsibility:
    'Triage incoming PE deal opportunities, run first-pass pricing analysis, and prepare structured handoffs for human review. Build durable procedures for repeatable intake patterns; flag everything novel.',
  priorities: [
    'Auditability before speed',
    'Procedure reuse before novel reasoning',
    'Operator readability before completeness',
  ],
  style:
    'Precise, audit-ready. Always cite source (deal doc, model, comparable). Distinguish "established procedure" from "first-pass judgment". Surface uncertainty explicitly — operators rely on calibrated confidence.',
  resourceBudget: {
    maxConcurrentWorkers: 2,
  },
  learningPolicy: {
    enabled: true,
    learnerActivation: 'always',
    alwaysRequireOperator: [
      'workflow_block',
      'directive_amendment',
      'workflow_refinement',
      'context_strategy',
    ],
    decayMode: 'flag',
  },
});

/**
 * Q2O-Approval ICP — quote-to-order routing/approval. Volume-heavy, mostly
 * codified work with occasional novel cases. Workers run on a fast tier;
 * Learner activates only on flagged anomalies to avoid overhead on routine
 * approvals.
 */
const Q2O_APPROVAL: EntityDirectives = EntityDirectivesSchema.parse({
  version: 1,
  responsibility:
    'Route, validate, and (where authorized) approve quote-to-order requests. Maintain the procedural library that codifies approval criteria for each product line.',
  priorities: [
    'Decision latency for routine quotes',
    'Auditability for exceptions',
    'Procedure coverage for novel patterns',
  ],
  style:
    'Direct, decision-first. State the action taken and the rule that justified it. For exceptions, list the specific guardrail that triggered escalation.',
  resourceBudget: {
    maxConcurrentWorkers: 8,
  },
  learningPolicy: {
    enabled: true,
    learnerActivation: 'flagged',
    alwaysRequireOperator: ['workflow_block', 'directive_amendment'],
    decayMode: 'flag',
  },
});

// ============================================================================
// Public catalog
// ============================================================================

/**
 * Ordered catalog used by the picker. Order matters — `blank` first so it
 * reads as the obvious starting point; ICP templates follow alphabetically
 * by id to keep the rendering stable across builds.
 */
export const DIRECTIVE_TEMPLATES: readonly DirectiveTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    tagline: 'Start from a minimal valid directives object.',
    description:
      "Only the required `scope.responsibility` field is filled in (with placeholder text). All other directives fall through to schema defaults. Recommended when the operator already knows the entity's posture and prefers to compose directives directly in the structured editor.",
    directives: BLANK,
  },
  {
    id: 'knowledge-vault',
    name: 'Knowledge Vault',
    tagline: 'An Obsidian-style personal vault — capture, connect, and grow linked notes.',
    description:
      'A personal thinking partner built on linked memory. Turns durable thoughts into atomic, titled notes connected by [[wikilinks]]; surfaces backlinks and nearby notes so each idea lands in context; maintains a scarce, curated /index.md map; and cultivates the referenced-but-unwritten (ghosts) and the unlinked (orphans) where the vault grows. Low concurrency and a conservative learner posture — capture is a conversation, not a worker fan-out, and the Coach is reserved for skill-learning, not personal knowledge. Best in a private space with an embedding model configured (semantic "find related on capture" is sharper than text search alone).',
    directives: KNOWLEDGE_VAULT,
  },
  {
    id: 'ml-optimization',
    name: 'ML Optimization',
    tagline: 'Experiment-driven model and pipeline tuning loop.',
    description:
      'Tuned for teams who own iterative model improvement: capable workers, high concurrency, learner activates on every run so the feedback loop closes quickly. Reproducibility and eval gates are baked in as constraints.',
    directives: ML_OPTIMIZATION,
  },
  {
    id: 'pe-intake-pricing',
    name: 'PE Intake & Pricing',
    tagline: 'High-stakes intake triage and first-pass pricing.',
    description:
      'Conservative posture for deal-flow triage and pricing analysis: capable workers but low concurrency, every learner proposal is staged for operator review (no auto-apply), and every output must cite its procedure version. External communication is hard-prohibited.',
    directives: PE_INTAKE_PRICING,
  },
  {
    id: 'q2o-approval',
    name: 'Q2O Approval',
    tagline: 'Volume quote-to-order routing and approval.',
    description:
      'Optimized for high-volume codified work with occasional novel cases: fast workers, high concurrency, learner activates only on flagged anomalies (so routine approvals stay cheap). Margin guardrails are explicit, exceptions are always routed.',
    directives: Q2O_APPROVAL,
  },
];

/** Convenience map for id-based lookup. Don't mutate — re-export of the catalog. */
export const DIRECTIVE_TEMPLATES_BY_ID: Readonly<Record<DirectiveTemplateId, DirectiveTemplate>> =
  Object.freeze(
    DIRECTIVE_TEMPLATES.reduce(
      (acc, t) => {
        acc[t.id] = t;
        return acc;
      },
      {} as Record<DirectiveTemplateId, DirectiveTemplate>,
    ),
  );

/**
 * Fetch a template by id. Returns `null` for unknown ids rather than
 * throwing — callers (UI, dev seed) should fall back to `blank` and
 * surface a warning rather than crashing on a typo'd template id.
 */
export function getDirectiveTemplate(id: string): DirectiveTemplate | null {
  return (DIRECTIVE_TEMPLATES_BY_ID as Record<string, DirectiveTemplate>)[id] ?? null;
}

const GENERIC_RESPONSIBILITY =
  'General-purpose workspace. Handle tasks, build procedures for repeating patterns, and improve over time based on feedback.';

/**
 * The directives a space is created with when its creator supplies none: the
 * blank template with a responsibility that is a statement rather than a
 * placeholder. Every space carries directives; the surfaces that read them
 * treat their absence as a failed load, and the Helmsman's per-space checks
 * key on them.
 */
export function defaultSpaceDirectives(): EntityDirectives {
  return { ...BLANK, responsibility: GENERIC_RESPONSIBILITY };
}
