/**
 * Conformance gate between an applet definition and its view source — the
 * guard against generated contract and generated code drifting even though one
 * author produced both. Entirely static plus server-side replay: call sites
 * are extracted regex-AST style (no parser, no DOM, no browser), every
 * template action is replayed headless against a synthesized minimal input,
 * and every produced state must survive a canonical JSON round-trip.
 *
 * Replay covers templates that write into actor-minted keys too: the room
 * mints those at runtime, so the gate grows the state around one (see
 * stateSeed) rather than skipping the action. Skipping is what makes a gate
 * report green over a template that cannot resolve, so an action whose input
 * cannot be synthesized fails instead of passing quietly.
 *
 * actor_supplied actions cannot be replayed without the view's own logic —
 * the gate covers their call-site names and envelope shape only.
 */
import {
  ACTOR_SUPPLIED_PATCH,
  RAW_PATCH_ACTION_NAME,
  resolveAppletLimits,
  type AppletDefinition,
  type AppletStatePatchOp,
  type AppletTemplatePatchOp,
} from '@aflow/schemas';
import {
  AppletPatchApplyError,
  AppletPatchBoundsError,
  AppletSchemaSafetyError,
  AppletTemplateError,
} from './errors.js';
import { canonicalJsonStringify, exceedsJsonDepth, isJsonRecord, jsonUtf8Bytes } from './json.js';
import { applyAppletStatePatch } from './applyStatePatch.js';
import { boundAppletStatePatch } from './patchBounds.js';
import { computeAppletDefinitionHash } from './definitionHash.js';
import { splitJsonPointer } from './pointer.js';
import { materializeAppletTemplatePatch } from './template.js';
import { validateAgainstAppletSchema } from './schemaValidation.js';
import {
  AppletStateSeedError,
  schemaAtAppletStatePath,
  seedAppletStateForPatch,
  type AppletSeedableOp,
} from './stateSeed.js';

// ============================================================================
// Call-site extraction
// ============================================================================

export interface AppletActCallSite {
  /** Literal first-argument action name, or null when the call site computes it. */
  name: string | null;
  line: number;
}

const DIRECT_ACT_RE = /\baflow\s*\??\.\s*act\s*\(/g;

/** A local binding whose initializer reads `window.aflow` (not a deeper member). */
const BRIDGE_ALIAS_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*?\bwindow\s*\??\.\s*aflow\b(?!\s*\??\.)/g;

/** `const { act } = window.aflow` — the destructured bridge is a wrapper-shaped alias of act itself. */
const DESTRUCTURED_ACT_RE =
  /\b(?:const|let|var)\s*\{[^}]*\bact\b(?:\s*:\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=[^;\n]*?\bwindow\s*\??\.\s*aflow\b/g;

const FUNCTION_WRAPPER_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)/g;
const ARROW_WRAPPER_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\)|([A-Za-z_$][\w$]*))\s*=>/g;

/**
 * Regex-AST heuristic: the forwarding call must appear near the declaration.
 * Full brace matching without a parser miscounts braces inside string
 * literals, so a bounded window is the honest scope.
 */
const WRAPPER_FORWARD_SCAN_CHARS = 2000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function isAflowReceiver(source: string, aflowIndex: number): boolean {
  const prev = aflowIndex > 0 ? source[aflowIndex - 1] : undefined;
  if (prev !== undefined && /[\w$]/.test(prev)) return false;
  let i = aflowIndex - 1;
  while (i >= 0 && /\s/.test(source[i]!)) i--;
  if (i < 0 || source[i] !== '.') return true;
  i--;
  while (i >= 0 && /\s/.test(source[i]!)) i--;
  const end = i;
  while (i >= 0 && /[\w$]/.test(source[i]!)) i--;
  const receiver = source.slice(i + 1, end + 1);
  return receiver === 'window' || receiver === 'globalThis';
}

function precededByKeyword(source: string, index: number, keyword: string): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i]!)) i--;
  const end = i;
  while (i >= 0 && /[\w$]/.test(source[i]!)) i--;
  return source.slice(i + 1, end + 1) === keyword;
}

/**
 * Classify the first argument at a call's opening paren: a plain string
 * literal (no expression parts, nothing appended) is a literal action name;
 * everything else — identifier, ternary, template with `${…}`, concatenation,
 * an empty argument list — is dynamic.
 */
function classifyFirstArgument(source: string, openParen: number): string | null {
  let i = openParen + 1;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let literal = '';
  let j = i + 1;
  let closed = false;
  while (j < source.length) {
    const ch = source[j]!;
    if (ch === '\\') {
      const next = source[j + 1];
      if (next === undefined) return null;
      literal += next;
      j += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source[j + 1] === '{') return null;
    if (ch === quote) {
      closed = true;
      break;
    }
    literal += ch;
    j++;
  }
  if (!closed) return null;
  j++;
  while (j < source.length && /\s/.test(source[j]!)) j++;
  const after = source[j];
  if (after !== ',' && after !== ')') return null;
  return literal;
}

function findActWrappers(source: string, bridgeAliases: ReadonlySet<string>): Set<string> {
  const invokers = [
    'aflow',
    String.raw`window\s*\.\s*aflow`,
    String.raw`globalThis\s*\.\s*aflow`,
    ...[...bridgeAliases].map(escapeRegExp),
  ];
  const candidates: Array<{ name: string; firstParam: string; index: number }> = [];
  for (const match of source.matchAll(FUNCTION_WRAPPER_RE)) {
    candidates.push({ name: match[1]!, firstParam: match[2]!, index: match.index });
  }
  for (const match of source.matchAll(ARROW_WRAPPER_RE)) {
    const firstParam = match[2] ?? match[3];
    if (firstParam === undefined) continue;
    candidates.push({ name: match[1]!, firstParam, index: match.index });
  }
  const wrappers = new Set<string>();
  for (const candidate of candidates) {
    const body = source.slice(candidate.index, candidate.index + WRAPPER_FORWARD_SCAN_CHARS);
    const forwardRe = new RegExp(
      String.raw`(?:${invokers.join('|')})\s*\.\s*act\s*\(\s*${escapeRegExp(candidate.firstParam)}\s*[,)]`,
    );
    if (forwardRe.test(body)) wrappers.add(candidate.name);
  }
  return wrappers;
}

/**
 * Scan view source for `aflow.act` call sites: direct `aflow.act(...)` /
 * `window.aflow.act(...)`, calls through a local `window.aflow` alias, and
 * calls through a local wrapper that forwards its first parameter to the
 * bridge (the idiom the generation prompt teaches).
 */

/**
 * Blank out comments before scanning, preserving offsets and line numbers.
 * String/template contexts are tracked so a `//` inside a URL literal is
 * never treated as a comment; a commented-out act() call must not burn the
 * repair round on a phantom action.
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') mode = 'line';
      else if (ch === '/' && next === '*') mode = 'block';
      else if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      if (mode === 'line' || mode === 'block') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
    } else if (mode === 'line') {
      if (ch === '\n') mode = 'code';
      else out[i] = ' ';
    } else if (mode === 'block') {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        mode = 'code';
        i += 2;
        continue;
      }
      if (ch !== '\n') out[i] = ' ';
    } else {
      // Inside a string/template: honor escapes; templates may span lines.
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (
        (mode === 'single' && ch === "'") ||
        (mode === 'double' && ch === '"') ||
        (mode === 'template' && ch === '`')
      ) {
        mode = 'code';
      } else if ((mode === 'single' || mode === 'double') && ch === '\n') {
        mode = 'code';
      }
    }
    i += 1;
  }
  return out.join('');
}

export function extractAppletActCallSites(rawSource: string): AppletActCallSite[] {
  // Offsets are preserved by the blanking, so line numbers and the
  // first-argument classifier keep reading the ORIGINAL bytes.
  const source = blankComments(rawSource);
  const seenParens = new Set<number>();
  const sites: Array<AppletActCallSite & { index: number }> = [];

  const record = (openParen: number): void => {
    if (seenParens.has(openParen)) return;
    seenParens.add(openParen);
    sites.push({
      name: classifyFirstArgument(source, openParen),
      line: lineOf(source, openParen),
      index: openParen,
    });
  };

  for (const match of source.matchAll(DIRECT_ACT_RE)) {
    if (!isAflowReceiver(source, match.index)) continue;
    record(match.index + match[0].length - 1);
  }

  const bridgeAliases = new Set<string>();
  for (const match of source.matchAll(BRIDGE_ALIAS_RE)) {
    bridgeAliases.add(match[1]!);
  }
  for (const alias of bridgeAliases) {
    const aliasActRe = new RegExp(
      String.raw`(?<![.\w$])${escapeRegExp(alias)}\s*\??\.\s*act\s*\(`,
      'g',
    );
    for (const match of source.matchAll(aliasActRe)) {
      record(match.index + match[0].length - 1);
    }
  }

  const destructuredNames = new Set<string>();
  for (const match of source.matchAll(DESTRUCTURED_ACT_RE)) {
    destructuredNames.add(match[1] ?? 'act');
  }
  for (const name of destructuredNames) {
    const bareActRe = new RegExp(String.raw`(?<![.\w$])${escapeRegExp(name)}\s*\(`, 'g');
    for (const match of source.matchAll(bareActRe)) {
      if (precededByKeyword(source, match.index, 'function')) continue;
      record(match.index + match[0].length - 1);
    }
  }

  for (const wrapper of findActWrappers(source, bridgeAliases)) {
    const callRe = new RegExp(String.raw`(?<![.\w$])${escapeRegExp(wrapper)}\s*\(`, 'g');
    for (const match of source.matchAll(callRe)) {
      if (precededByKeyword(source, match.index, 'function')) continue;
      record(match.index + match[0].length - 1);
    }
  }

  sites.sort((a, b) => a.index - b.index);
  return sites.map(({ name, line }) => ({ name, line }));
}

import { synthesizeMinimalAppletInput } from './sampleValue.js';

export { synthesizeMinimalAppletInput };

// ============================================================================
// Replay preparation
// ============================================================================

/**
 * Where each materialized operation's path stops being knowable — the index of
 * its first input-derived segment. Everything above that is literal and must
 * hold in the state an instance is born with.
 */
function seedableOps(
  template: readonly AppletTemplatePatchOp[],
  patch: readonly AppletStatePatchOp[],
): AppletSeedableOp[] {
  return patch.map((op, index) => {
    const seedableFrom = firstInputDerivedSegment(template[index]);
    return seedableFrom === undefined ? { op } : { op, seedableFrom };
  });
}

function firstInputDerivedSegment(
  templateOp: AppletTemplatePatchOp | undefined,
): number | undefined {
  const pathTemplate = templateOp?.pathTemplate;
  if (pathTemplate === undefined) return undefined;
  const [head, ...segments] = pathTemplate;
  const headDepth = splitJsonPointer(head).length - 1;
  for (const [index, segment] of segments.entries()) {
    if (typeof segment !== 'string') return headDepth + index;
  }
  return undefined;
}

/**
 * A `test` asserts a domain fact replay cannot manufacture, so replay only
 * proves its path resolves. What IS decidable statically is whether the
 * asserted value could ever sit there — an assertion the state schema forbids
 * is an action no actor can ever complete.
 */
function firstUnrepresentableAssertion(
  stateSchema: Record<string, unknown>,
  patch: readonly AppletStatePatchOp[],
  context: { definitionHash: string; actionName: string },
): { path: string; reason: string } | undefined {
  for (const op of patch) {
    if (op.op !== 'test') continue;
    const node = schemaAtAppletStatePath(stateSchema, op.path);
    if (node === undefined) continue;
    const check = validateAgainstAppletSchema({
      schema: rootedSubSchema(stateSchema, node),
      cacheKey: `${context.definitionHash}#assert:${context.actionName}:${op.path}`,
      data: op.value,
    });
    if (!check.valid) return { path: op.path, reason: check.errors.join('; ') };
  }
  return undefined;
}

/** A sub-schema still resolves its `$ref`s only against the document it came from. */
function rootedSubSchema(
  stateSchema: Record<string, unknown>,
  node: unknown,
): Record<string, unknown> {
  const defs = stateSchema['$defs'];
  return isJsonRecord(defs) ? { allOf: [node], $defs: defs } : { allOf: [node] };
}

// ============================================================================
// The gate
// ============================================================================

export type AppletConformanceIssueCode =
  | 'unknown_action_call_site'
  | 'all_call_sites_dynamic'
  | 'missing_call_site'
  | 'sample_input_unsatisfiable'
  | 'template_replay_failed'
  | 'reload_convergence_failed';

export interface AppletConformanceIssue {
  code: AppletConformanceIssueCode;
  message: string;
  actionName?: string;
  line?: number;
}

export interface AppletConformanceResult {
  /** True when no errors — warnings never fail the gate. */
  ok: boolean;
  errors: AppletConformanceIssue[];
  warnings: AppletConformanceIssue[];
  callSites: AppletActCallSite[];
}

export function checkAppletConformance(params: {
  definition: AppletDefinition;
  source: string;
  /** Reuse the caller's pinned hash (it keys the validator cache); recomputed when absent. */
  definitionHash?: string;
}): AppletConformanceResult {
  const { definition, source } = params;
  const definitionHash = params.definitionHash ?? computeAppletDefinitionHash(definition);
  const errors: AppletConformanceIssue[] = [];
  const warnings: AppletConformanceIssue[] = [];

  const callSites = extractAppletActCallSites(source);
  const literalSites = callSites.filter(
    (site): site is AppletActCallSite & { name: string } => site.name !== null,
  );
  const declaredNames = new Set(definition.actions.map((action) => action.name));

  for (const site of literalSites) {
    if (declaredNames.has(site.name) || site.name === RAW_PATCH_ACTION_NAME) continue;
    const declaredList = [...declaredNames].join("', '");
    errors.push({
      code: 'unknown_action_call_site',
      actionName: site.name,
      line: site.line,
      message:
        `Line ${site.line}: the view calls aflow.act('${site.name}') but the definition declares no such action — ` +
        `declared actions: '${declaredList}' (plus the built-in '${RAW_PATCH_ACTION_NAME}'). ` +
        `Either declare the action or fix the call site.`,
    });
  }

  const allDynamic = callSites.length > 0 && literalSites.length === 0;
  if (allDynamic) {
    errors.push({
      code: 'all_call_sites_dynamic',
      message:
        'Every aflow.act call site computes its action name at runtime, so none of the wiring can be ' +
        'checked against the declared actions — call declared actions with literal names (a shared helper ' +
        "forwarding literals like act('set_budget', input) is fine; a fully dynamic dispatcher is not verifiable).",
    });
  } else {
    for (const action of definition.actions) {
      if (action.audience === 'agent') continue;
      if (literalSites.some((site) => site.name === action.name)) continue;
      warnings.push({
        code: 'missing_call_site',
        actionName: action.name,
        message:
          `Declared action '${action.name}' (audience '${action.audience}') has no aflow.act call site ` +
          `in the view — humans cannot reach it from the UI; the agent may still drive it.`,
      });
    }
  }

  const limits = resolveAppletLimits(definition.limits);
  const replayed: Array<{ actionName: string; state: Record<string, unknown> }> = [];
  for (const action of definition.actions) {
    if (action.patch === ACTOR_SUPPLIED_PATCH) continue;
    const sample = synthesizeMinimalAppletInput(action.inputSchema);
    let sampleValid = false;
    if (sample !== undefined) {
      try {
        sampleValid = validateAgainstAppletSchema({
          schema: action.inputSchema,
          cacheKey: `${definitionHash}#action:${action.name}`,
          data: sample,
        }).valid;
      } catch (err) {
        if (!(err instanceof AppletSchemaSafetyError)) throw err;
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message: `Action '${action.name}': inputSchema is unsafe: ${err.message}`,
        });
        continue;
      }
    }
    if (sample === undefined || !sampleValid) {
      errors.push({
        code: 'sample_input_unsatisfiable',
        actionName: action.name,
        message:
          `Action '${action.name}': no valid input could be built from its inputSchema, so its patch ` +
          `template cannot be replayed and nothing about it is checked. Either the schema admits no ` +
          `input at all, or it constrains one outside the declared dialect the gate can satisfy — ` +
          `narrow it until one minimal input exists.`,
      });
      continue;
    }
    if (jsonUtf8Bytes(sample) > limits.maxInputBytes) {
      errors.push({
        code: 'template_replay_failed',
        actionName: action.name,
        message:
          `Action '${action.name}': the smallest valid input already serializes over the ` +
          `${limits.maxInputBytes}-byte input cap — no actor can ever invoke this action.`,
      });
      continue;
    }
    try {
      const patch = materializeAppletTemplatePatch(action.patch.template, sample);
      boundAppletStatePatch(patch, limits);
      const unreachable = firstUnrepresentableAssertion(definition.stateSchema, patch, {
        definitionHash,
        actionName: action.name,
      });
      if (unreachable !== undefined) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message:
            `Action '${action.name}': the template asserts a value at '${unreachable.path}' that ` +
            `stateSchema never admits there (${unreachable.reason}), so the action can never apply.`,
        });
        continue;
      }
      const seeded = seedAppletStateForPatch({
        initialState: definition.initialState,
        stateSchema: definition.stateSchema,
        ops: seedableOps(action.patch.template, patch),
      });
      const seedCheck = validateAgainstAppletSchema({
        schema: definition.stateSchema,
        cacheKey: `${definitionHash}#state`,
        data: seeded.initialState,
      });
      if (!seedCheck.valid) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message:
            `Action '${action.name}': the template writes into keys an actor mints, and the state ` +
            `holding them violates stateSchema (${seedCheck.errors.join('; ')}) — the ids the ` +
            `inputSchema admits are not ids the state schema accepts as keys.`,
        });
        continue;
      }
      const nextState = applyAppletStatePatch(seeded.initialState, seeded.patch);
      if (jsonUtf8Bytes(nextState) > limits.maxStateBytes) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message: `Action '${action.name}': the replayed state exceeds the ${limits.maxStateBytes}-byte state cap.`,
        });
        continue;
      }
      if (exceedsJsonDepth(nextState, limits.maxJsonDepth)) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message: `Action '${action.name}': the replayed state nests deeper than ${limits.maxJsonDepth} levels.`,
        });
        continue;
      }
      const stateCheck = validateAgainstAppletSchema({
        schema: definition.stateSchema,
        cacheKey: `${definitionHash}#state`,
        data: nextState,
      });
      if (!stateCheck.valid) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message:
            `Replaying '${action.name}' with a minimal input produced a state that violates ` +
            `stateSchema: ${stateCheck.errors.join('; ')}`,
        });
        continue;
      }
      replayed.push({ actionName: action.name, state: nextState });
    } catch (err) {
      if (err instanceof AppletTemplateError) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message:
            `Action '${action.name}': the patch template did not materialize from a minimal valid ` +
            `input (${err.message}) — a template may only reference input fields its inputSchema requires.`,
        });
      } else if (err instanceof AppletPatchBoundsError) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message: `Action '${action.name}': the materialized patch violates the platform bounds: ${err.message}`,
        });
      } else if (err instanceof AppletPatchApplyError) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message:
            `Action '${action.name}': the materialized patch did not apply to initialState ` +
            `(${err.message}) — a template must succeed against the state an instance is born with: ` +
            `use 'add' for members initialState lacks, or birth the container in initialState.`,
        });
      } else if (err instanceof AppletStateSeedError) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message:
            `Action '${action.name}': the template writes through an actor-minted key at ` +
            `'${err.pointer}' that no reachable state can hold — ${err.message}.`,
        });
      } else if (err instanceof AppletSchemaSafetyError) {
        errors.push({
          code: 'template_replay_failed',
          actionName: action.name,
          message: `Action '${action.name}': stateSchema is unsafe: ${err.message}`,
        });
      } else {
        throw err;
      }
    }
  }

  const convergenceTargets: Array<{
    label: string;
    actionName?: string;
    state: Record<string, unknown>;
  }> = [
    { label: 'initialState', state: definition.initialState },
    ...replayed.map((entry) => ({
      label: `the state after '${entry.actionName}'`,
      actionName: entry.actionName,
      state: entry.state,
    })),
  ];
  for (const target of convergenceTargets) {
    const serialized = canonicalJsonStringify(target.state);
    let reloaded: unknown;
    let converges = false;
    try {
      reloaded = JSON.parse(serialized);
      converges =
        validateAgainstAppletSchema({
          schema: definition.stateSchema,
          cacheKey: `${definitionHash}#state`,
          data: reloaded,
        }).valid && canonicalJsonStringify(reloaded) === serialized;
    } catch {
      converges = false;
    }
    if (!converges) {
      errors.push({
        code: 'reload_convergence_failed',
        ...(target.actionName !== undefined ? { actionName: target.actionName } : {}),
        message:
          `${target.label} does not survive a canonical JSON round-trip — state must reload to ` +
          `exactly the value that was stored (non-JSON values like NaN, Infinity or undefined cannot live in state).`,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings, callSites };
}
