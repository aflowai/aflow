/**
 * The performance review's pre-registered rules and the verdict they hold
 * (Plan 343 Part E). The analyst's verdict schema carries the rules a schema
 * can carry: a metric is a cited value or a measurement gap, every correction
 * cites what it rests on, a weekly review may only hold or halt, and no
 * conclusion is drawn below the pooled sample floor. The pooled sample is
 * the count the trading.pooled-sample rule held the period read to, and the
 * verdict is pinned to it. The reviewer answers every rule by id, and a rule
 * it finds broken forces a refusal. Only an approved verdict is applied. The
 * verdict authors no successor contract: at the boundary its correction goes
 * to the Campaign Successor, whose lenses review the draft the run applies.
 */
import { bind } from './localPrShepherdWiring.js';

/** The registered runtime validator that recounts the pooled sample from the thesis ledger. */
export const POOLED_SAMPLE_VALIDATOR_REF = 'trading.pooled-sample' as const;

/** The measurement gap a verdict names when the eval read did not reach its last page. */
export const EVAL_RESULTS_GAP = 'evalResults';

/** No review draws a conclusion below this pooled sample, whatever the campaign's floor. */
export const POOLED_N_FLOOR = 30;

export const REVIEW_KINDS = ['weekly', 'boundary'] as const;

/** Where each review doc is written, one per period. */
export const REVIEW_DOC_PATH_TEMPLATE = '/strategy/reviews/{periodStart}-to-{periodEnd}.md';

export const LAYER1_METRICS = [
  'cycleReliability',
  'thesisDiscipline',
  'resolutionRate',
  'fillDiscipline',
  'calibration',
  'armAttribution',
  'loopHealth',
  'exposureDiscipline',
] as const;

export const LAYER2_METRICS = [
  'equityReturnPct',
  'benchmarkReturnPct',
  'excessReturnPct',
  'sharpe',
  'maxDrawdownPct',
  'calibrationGap',
] as const;

/** The caps a boundary correction may propose changing. The Campaign Successor drafts the change. */
export const CAP_FIELDS = [
  'maxThesesPerDay',
  'maxPositionSizePct',
  'maxGrossExposurePct',
  'minHorizonTradingDays',
  'maxHorizonTradingDays',
] as const;

export const PRE_REGISTERED_RULES = [
  {
    id: 'pooled-n-floor',
    rule: `Below a pooled sample of ${String(POOLED_N_FLOOR)} resolutions of filled entries, or the campaign's pooledSampleFloor where it is higher, no Layer 2 goal reads on or off track, no arm is promoted or retired, and no cap or universe changes.`,
  },
  {
    id: 'cap-change-cited',
    rule: 'Every cap change cites the resolved theses it rests on. A cap change without that citation is refused.',
  },
  {
    id: 'correction-cited',
    rule: 'Every arm decision, universe change and halt cites the ledger docs it rests on. A promote, a retire or a universe change cites resolved theses.',
  },
  {
    id: 'measured-not-estimated',
    rule: 'Every metric is a value computed from the ledger docs it cites, or a measurement gap with its reason. A metric the ledger cannot give is never estimated.',
  },
  {
    id: 'mid-window-authority',
    rule: 'A weekly review only holds or halts. A halt rests on Layer 1 red or a principle breach. Arms, caps and the universe change only at the window boundary, and only through a Campaign Successor draft every lens approved.',
  },
  {
    id: 'principle-breach-cited',
    rule: 'Every principle breach names the principle in the principles file and cites the docs that show it.',
  },
] as const;

export const PRE_REGISTERED_RULE_IDS = PRE_REGISTERED_RULES.map((rule) => rule.id);

const PROSE = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const LEDGER_PATH = { type: 'string', pattern: '^/[^\\s]+$' };
const CITATIONS = { type: 'array', minItems: 1, maxItems: 200, items: LEDGER_PATH };
const RESOLVED_DOC = { type: 'string', pattern: '^/portfolio/theses/resolved/' };
/** Citations that name at least one resolved thesis. */
const RESOLUTION_CITATIONS = { ...CITATIONS, contains: RESOLVED_DOC };

/** A metric is either a value from cited docs, or a measurement gap with its reason. Never both, never neither. */
export const METRIC_SCHEMA = {
  type: 'object',
  required: ['value', 'gap', 'citations'],
  additionalProperties: false,
  properties: {
    value: { type: ['number', 'null'] },
    gap: { type: ['string', 'null'], maxLength: 2000 },
    citations: { type: 'array', maxItems: 200, items: LEDGER_PATH },
  },
  oneOf: [
    {
      properties: {
        value: { type: 'number' },
        gap: { type: 'null' },
        citations: { minItems: 1 },
      },
    },
    {
      properties: { value: { type: 'null' }, gap: { type: 'string', minLength: 1 } },
    },
  ],
};

const metricsOf = (names: readonly string[]) => ({
  type: 'object',
  required: [...names],
  additionalProperties: false,
  properties: Object.fromEntries(names.map((name) => [name, METRIC_SCHEMA])),
});

const ARM_DECISION = {
  type: 'object',
  required: ['hypothesisId', 'decision', 'reason', 'citations'],
  additionalProperties: false,
  properties: {
    hypothesisId: { type: 'string', minLength: 1 },
    decision: { enum: ['hold', 'promote', 'retire'] },
    reason: PROSE(4000),
    citations: CITATIONS,
  },
  if: { properties: { decision: { enum: ['promote', 'retire'] } } },
  then: { properties: { citations: RESOLUTION_CITATIONS } },
};

const CAP_CHANGE = {
  type: 'object',
  required: ['field', 'from', 'to', 'reason', 'citations'],
  additionalProperties: false,
  properties: {
    field: { enum: [...CAP_FIELDS] },
    from: { type: 'number' },
    to: { type: 'number' },
    reason: PROSE(4000),
    citations: RESOLUTION_CITATIONS,
  },
};

const UNIVERSE_CHANGE = {
  type: 'object',
  required: ['symbol', 'change', 'reason', 'citations'],
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', pattern: '^[A-Z][A-Z.]{0,9}$' },
    change: { enum: ['add', 'remove'] },
    reason: PROSE(4000),
    citations: RESOLUTION_CITATIONS,
  },
};

const HALT = {
  type: 'object',
  required: ['trigger', 'reason', 'citations'],
  additionalProperties: false,
  properties: {
    trigger: { enum: ['layer1_red', 'principle_breach'] },
    reason: PROSE(4000),
    citations: CITATIONS,
  },
};

const CORRECTION = {
  type: 'object',
  required: ['action', 'halt', 'arms', 'capChanges', 'universeChanges'],
  additionalProperties: false,
  properties: {
    action: {
      enum: ['none', 'halt', 'boundary'],
      description:
        'none holds every arm and changes nothing, weekly only. halt ends the campaign now. Neither carries an arm, cap or universe change. boundary, at the window boundary only, hands this correction to the Campaign Successor, and the run applies the draft every lens approved. A boundary review hands over or halts.',
    },
    halt: { anyOf: [HALT, { type: 'null' }] },
    arms: { type: 'array', maxItems: 8, items: ARM_DECISION },
    capChanges: { type: 'array', maxItems: CAP_FIELDS.length, items: CAP_CHANGE },
    universeChanges: { type: 'array', maxItems: 30, items: UNIVERSE_CHANGE },
  },
};

const HOLDS_STILL = {
  properties: {
    arms: { items: { properties: { decision: { const: 'hold' } } } },
    capChanges: { maxItems: 0 },
    universeChanges: { maxItems: 0 },
  },
};

/** Below a floor, no outcome goal reads on or off track and nothing but a halt or a carry changes. */
const belowFloor = (floor: unknown) => ({
  if: { required: ['pooledN'], properties: { pooledN: { exclusiveMaximum: floor } } },
  then: {
    properties: {
      goals: {
        items: {
          if: { properties: { layer: { const: 'layer2' } } },
          then: { properties: { status: { enum: ['inconclusive', 'unmeasurable'] } } },
        },
      },
      correction: HOLDS_STILL,
    },
  },
});

/** The rules between fields, which the schema holds before the reviewer reads the verdict. */
const VERDICT_RULES = [
  // A weekly review only holds or halts.
  {
    if: { properties: { kind: { const: 'weekly' } } },
    then: {
      properties: {
        correction: {
          properties: {
            ...HOLDS_STILL.properties,
            action: { enum: ['none', 'halt'] },
          },
        },
      },
    },
  },
  // The window has ended at the boundary, so the review hands over or halts. A carry is a hand-over that changes nothing.
  {
    if: { properties: { kind: { const: 'boundary' } } },
    then: {
      properties: { correction: { properties: { action: { enum: ['boundary', 'halt'] } } } },
    },
  },
  // none holds every arm and halt ends the campaign, so neither carries a change it would drop.
  {
    if: {
      properties: { correction: { properties: { action: { enum: ['none', 'halt'] } } } },
    },
    then: { properties: { correction: HOLDS_STILL } },
  },
  {
    if: { properties: { correction: { properties: { action: { const: 'halt' } } } } },
    then: { properties: { correction: { properties: { halt: HALT } } } },
    else: { properties: { correction: { properties: { halt: { type: 'null' } } } } },
  },
  // A Layer 1 halt needs Layer 1 red. A principle halt needs a cited breach.
  {
    if: {
      properties: {
        correction: {
          properties: {
            halt: { type: 'object', properties: { trigger: { const: 'layer1_red' } } },
          },
        },
      },
    },
    then: { properties: { layer1: { properties: { status: { const: 'red' } } } } },
  },
  {
    if: {
      properties: {
        correction: {
          properties: {
            halt: { type: 'object', properties: { trigger: { const: 'principle_breach' } } },
          },
        },
      },
    },
    then: { properties: { principleBreaches: { minItems: 1 } } },
  },
  belowFloor(POOLED_N_FLOOR),
  belowFloor(bind('pooledSampleFloor')),
  // An eval read that stopped short is a gap, never the whole campaign.
  {
    if: { properties: { evalsComplete: { const: false } } },
    then: {
      properties: {
        measurementGaps: {
          contains: { type: 'object', properties: { metric: { const: EVAL_RESULTS_GAP } } },
        },
      },
    },
  },
];

/**
 * The analyst's verdict. Its kind, period, campaign and arm table are pinned
 * to the run, so the verdict judges the period it was asked to.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  required: [
    'kind',
    'periodStart',
    'periodEnd',
    'campaignId',
    'pooledN',
    'evalsComplete',
    'layer1',
    'layer2',
    'goals',
    'principleBreaches',
    'measurementGaps',
    'correction',
    'headline',
    'doc',
  ],
  additionalProperties: false,
  allOf: VERDICT_RULES,
  properties: {
    kind: { const: bind('kind') },
    periodStart: { const: bind('periodStart') },
    periodEnd: { const: bind('periodEnd') },
    campaignId: { const: bind('campaignId') },
    pooledN: {
      const: bind('pooledN'),
      description:
        'The resolutions of filled entries pooled across every arm, as the period read counted them. It is pinned: the ledger recount decides it.',
    },
    evalsComplete: {
      const: bind('evalsComplete'),
      description: `Whether the eval read reached its last page, copied from evals.complete. It is pinned. Where it is false, name ${EVAL_RESULTS_GAP} in measurementGaps.`,
    },
    layer1: {
      type: 'object',
      required: ['status', 'metrics'],
      additionalProperties: false,
      properties: {
        status: { enum: ['green', 'amber', 'red'] },
        metrics: metricsOf(LAYER1_METRICS),
      },
    },
    layer2: {
      type: 'object',
      required: ['metrics', 'arms'],
      additionalProperties: false,
      properties: {
        metrics: metricsOf(LAYER2_METRICS),
        arms: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            required: ['hypothesisId', 'opened', 'resolvedFilled', 'expectancyR'],
            additionalProperties: false,
            properties: {
              hypothesisId: { type: 'string', minLength: 1 },
              opened: { type: 'integer', minimum: 0 },
              resolvedFilled: { type: 'integer', minimum: 0 },
              expectancyR: METRIC_SCHEMA,
            },
          },
        },
      },
    },
    goals: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        required: ['goalId', 'layer', 'status', 'evidence', 'citations'],
        additionalProperties: false,
        properties: {
          goalId: { type: 'string', minLength: 1, maxLength: 64 },
          layer: { enum: ['layer1', 'layer2'] },
          status: { enum: ['on_track', 'off_track', 'inconclusive', 'unmeasurable'] },
          evidence: PROSE(4000),
          citations: { type: 'array', maxItems: 200, items: LEDGER_PATH },
        },
        if: { properties: { status: { enum: ['on_track', 'off_track'] } } },
        then: { properties: { citations: { minItems: 1 } } },
      },
    },
    principleBreaches: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['principle', 'detail', 'citations'],
        additionalProperties: false,
        properties: { principle: PROSE(500), detail: PROSE(4000), citations: CITATIONS },
      },
    },
    measurementGaps: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        required: ['metric', 'reason'],
        additionalProperties: false,
        properties: { metric: PROSE(200), reason: PROSE(2000) },
      },
    },
    correction: CORRECTION,
    headline: PROSE(400),
    doc: { ...PROSE(60000), description: 'The review doc, in Markdown.' },
  },
};

/** The reviewer answers every pre-registered rule by id. A broken rule refuses the verdict. */
export const REVIEW_PASS_SCHEMA = {
  type: 'object',
  required: ['checks', 'verdict', 'reason'],
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      minItems: PRE_REGISTERED_RULE_IDS.length,
      maxItems: PRE_REGISTERED_RULE_IDS.length,
      items: {
        type: 'object',
        required: ['ruleId', 'holds', 'finding'],
        additionalProperties: false,
        properties: {
          ruleId: { enum: [...PRE_REGISTERED_RULE_IDS] },
          holds: { type: 'boolean' },
          finding: PROSE(4000),
        },
      },
      allOf: PRE_REGISTERED_RULE_IDS.map((id) => ({
        contains: { type: 'object', properties: { ruleId: { const: id } } },
      })),
    },
    verdict: { enum: ['approved', 'refused'] },
    reason: PROSE(8000),
  },
  if: {
    properties: {
      checks: { contains: { type: 'object', properties: { holds: { const: false } } } },
    },
  },
  then: { properties: { verdict: { const: 'refused' } } },
};
