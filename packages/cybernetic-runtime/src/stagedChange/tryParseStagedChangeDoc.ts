import { createHash } from 'node:crypto';
import { StagedChangeSchema, type StagedChange } from '@aflow/schemas';
import { getMeter, type Counter } from '@aflow/observability';
import { getCyberneticLogger } from '../logger.js';

/**
 * Context passed by the reader so the warn log can be triaged. Doc id /
 * path / space id live in the log only (NOT in metric labels — they would
 * blow up time-series cardinality).
 */
export interface StagedChangeParseContext {
  tenantId: string;
  spaceId: string;
  docId?: string;
  docPath: string;
  /** Source surface — helps triage which reader observed the failure. */
  reader: string;
}

export type StagedChangeParseResult =
  | { ok: true; staged: StagedChange }
  | { ok: false; reason: 'json' | 'schema'; zodPath: string | undefined };

const MAX_DEDUP_SIGNATURES = 1000;
const loggedSignatures = new Set<string>();

let parseFailuresCounter: Counter | null = null;
function counter(): Counter {
  if (!parseFailuresCounter) {
    parseFailuresCounter = getMeter('phoenix-cybernetic-runtime', '0.1').createCounter(
      'cybernetic.stagedchange.parse_failures_total',
      {
        description:
          'StagedChange doc parse failures. Any non-zero value over a sustained window ' +
          'indicates schema/runtime drift (the writer emits a shape the schema does ' +
          'not accept) or doc corruption. Labels: schema, reason ("json"|"schema"), ' +
          'zod_path (top-level error path, "n/a" when reason="json"). Low cardinality ' +
          'by design — doc id / tenant / space live in the warn log only.',
        unit: '1',
      },
    );
  }
  return parseFailuresCounter;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Bring a persisted StagedChange doc up to the current schema for known,
 * back-compatible metadata drifts, so a proposal authored before a required
 * metadata field existed still parses (and stays visible on the operator
 * surface) instead of being silently dropped. Authoring stays strict — the
 * schema keeps the field required, so a fresh proposal must still carry it;
 * this only fills the gap for docs already at rest. Only fields that can be
 * recovered honestly are normalized: never the proposal's own change ops, whose
 * missing values are real (a binding, a URL) that cannot be invented.
 */
export function normalizeStagedChangeRaw(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;

  // An unconfirmed cause is the conservative reading of a warrant with no
  // recorded causeStatus: the downgrade guard records inferred-without-
  // confirmation as an observation rather than applying it as a change.
  const evidence = raw['evidence'];
  if (isRecord(evidence) && isRecord(evidence['warrant'])) {
    const warrant = evidence['warrant'];
    if (warrant['causeStatus'] !== 'observed' && warrant['causeStatus'] !== 'inferred') {
      warrant['causeStatus'] = 'inferred';
    }
  }

  // `proposal.validations` is an advisory cache recomputed at read; an entry
  // missing its (now-required) contract is dropped rather than fabricated.
  const proposal = raw['proposal'];
  if (isRecord(proposal) && isRecord(proposal['validations'])) {
    if (!isRecord(proposal['validations']['contract'])) {
      delete proposal['validations'];
    }
  }

  return raw;
}

export function tryParseStagedChangeDoc(
  inlineContent: string,
  ctx: StagedChangeParseContext,
): StagedChangeParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(inlineContent);
  } catch (err) {
    emitFailure(ctx, 'json', undefined, inlineContent, err);
    return { ok: false, reason: 'json', zodPath: undefined };
  }

  raw = normalizeStagedChangeRaw(raw);
  const result = StagedChangeSchema.safeParse(raw);
  if (result.success) return { ok: true, staged: result.data };

  const zodPath = result.error.errors[0]?.path.map(String).join('.') ?? 'unknown';
  emitFailure(ctx, 'schema', zodPath, inlineContent, result.error);
  return { ok: false, reason: 'schema', zodPath };
}

function emitFailure(
  ctx: StagedChangeParseContext,
  reason: 'json' | 'schema',
  zodPath: string | undefined,
  inlineContent: string,
  err: unknown,
): void {
  counter().add(1, {
    schema: 'StagedChangeSchema',
    reason,
    zod_path: zodPath ?? 'n/a',
  });

  // sha256 first 16 hex chars is plenty for dedup; collision risk is fine
  // for "log this kind of broken doc once per process window".
  const contentHash = createHash('sha256').update(inlineContent).digest('hex').slice(0, 16);
  const signature = `${reason}|${zodPath ?? 'n/a'}|${contentHash}`;
  if (loggedSignatures.has(signature)) return;
  if (loggedSignatures.size >= MAX_DEDUP_SIGNATURES) loggedSignatures.clear();
  loggedSignatures.add(signature);

  getCyberneticLogger().warn(
    `[stagedchange] ${reason} parse failure — dropping doc (reader=${ctx.reader})`,
    {
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      ...(ctx.docId ? { docId: ctx.docId } : {}),
      docPath: ctx.docPath,
      reader: ctx.reader,
      reason,
      ...(zodPath ? { zodPath } : {}),
      contentHash,
      error: err instanceof Error ? err.message : String(err),
    },
  );
}

/**
 * Test-only — reset the dedup set so each test starts from a clean slate.
 * Not part of the public runtime API; production code MUST NOT call this.
 */
export function __resetParseFailureDedupForTests(): void {
  loggedSignatures.clear();
}
