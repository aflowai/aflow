/**
 * Validation + one-repair-round resolution of the applet definition emitted
 * by ui.artifact.generate. Mirrors the source repair loop: first candidate →
 * validate → at most one model round → validate again. A definition that
 * still fails surfaces as error diagnostics, failing the draft — never a
 * silently definition-less applet. Validation includes the conformance gate
 * against the final source, so contract/code drift feeds the same repair
 * round as schema failures.
 */
import {
  AppletDefinitionSchema,
  type AppletDefinition,
  type ValidationDiagnostic,
} from '@aflow/schemas';
import {
  AppletSchemaSafetyError,
  assertAppletSchemaSafe,
  checkAppletConformance,
  computeAppletDefinitionHash,
  validateAgainstAppletSchema,
} from '@aflow/applet-runtime';
import type { ChatMessage } from '@aflow/ai-client';
import { buildAppletDefinitionRepairMessages } from './promptAppletDefinition.js';

const MAX_DEFINITION_DIAGNOSTICS = 12;

export interface AppletDefinitionUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCostUsd: number;
  completionCostUsd: number;
  totalCostUsd: number;
}

/** One repair call — injected so tests stub the model and the handler wires the real client. */
export type AppletDefinitionRepairFn = (
  messages: ChatMessage[],
) => Promise<{ content: string | null; usage?: AppletDefinitionUsage }>;

export type AppletDefinitionValidation =
  | { ok: true; definition: AppletDefinition; definitionHash: string; warnings: string[] }
  | { ok: false; errors: string[]; nonconformant: boolean };

/**
 * Schema + safety validation of the emitted definition; with `source` the
 * conformance gate runs too (call-site diff, headless template replay,
 * reload convergence), so both feed the same repair round.
 */
export function validateAppletDefinitionCandidate(
  candidate: unknown,
  source?: string,
): AppletDefinitionValidation {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { ok: false, errors: ['definition must be a JSON object'], nonconformant: false };
  }
  const parsed = AppletDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { ok: false, errors, nonconformant: false };
  }
  const definition = parsed.data;
  const definitionHash = computeAppletDefinitionHash(definition);

  const errors: string[] = [];
  try {
    const birth = validateAgainstAppletSchema({
      schema: definition.stateSchema,
      cacheKey: `${definitionHash}#state`,
      data: definition.initialState,
    });
    if (!birth.valid) {
      errors.push(
        ...birth.errors.map((message) => `initialState does not satisfy stateSchema: ${message}`),
      );
    }
  } catch (err) {
    if (err instanceof AppletSchemaSafetyError) {
      errors.push(`stateSchema is unsafe: ${err.message}`);
    } else {
      throw err;
    }
  }
  for (const action of definition.actions) {
    try {
      assertAppletSchemaSafe(action.inputSchema);
    } catch (err) {
      if (err instanceof AppletSchemaSafetyError) {
        errors.push(`action '${action.name}' inputSchema is unsafe: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, nonconformant: false };

  if (source === undefined) return { ok: true, definition, definitionHash, warnings: [] };
  const conformance = checkAppletConformance({ definition, source, definitionHash });
  if (!conformance.ok) {
    return {
      ok: false,
      errors: conformance.errors.map((issue) => issue.message),
      nonconformant: true,
    };
  }
  return {
    ok: true,
    definition,
    definitionHash,
    warnings: conformance.warnings.map((issue) => issue.message),
  };
}

/** Accepts the bare definition object or a `{ "definition": … }` wrapper. */
export function parseRepairedDefinition(raw: string): unknown {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n/m, '');
  cleaned = cleaned.replace(/\n```\s*$/m, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return undefined;
  }
  if (typeof parsed === 'object' && parsed !== null && !('appletKey' in parsed)) {
    const wrapped = (parsed as Record<string, unknown>)['definition'];
    if (typeof wrapped === 'object' && wrapped !== null) return wrapped;
  }
  return parsed;
}

export interface ResolveAppletDefinitionResult {
  definition?: AppletDefinition;
  definitionHash?: string;
  /** Errors when resolution failed; conformance warnings may accompany a successful definition. */
  diagnostics: ValidationDiagnostic[];
  repaired: boolean;
  usage?: AppletDefinitionUsage;
}

function toDiagnostics(
  code: string,
  messages: string[],
  severity: 'error' | 'warning' = 'error',
): ValidationDiagnostic[] {
  return messages.slice(0, MAX_DEFINITION_DIAGNOSTICS).map((message) => ({
    severity,
    code,
    message: message.slice(0, 2000),
  }));
}

function failureCode(candidateMissing: boolean, nonconformant: boolean): string {
  if (candidateMissing) return 'APPLET_DEFINITION_MISSING';
  return nonconformant ? 'APPLET_CONFORMANCE_INVALID' : 'APPLET_DEFINITION_INVALID';
}

function conformanceWarningDiagnostics(warnings: string[]): ValidationDiagnostic[] {
  return toDiagnostics('APPLET_CONFORMANCE_WARNING', warnings, 'warning');
}

/**
 * Resolve the emitted definition: validate, then at most one repair round.
 * `repair` is absent when no AI provider is resolvable (template fallback) —
 * the missing/invalid definition then fails the draft directly.
 */
export async function resolveAppletDefinition(params: {
  candidate: unknown;
  source: string;
  repair?: AppletDefinitionRepairFn;
}): Promise<ResolveAppletDefinitionResult> {
  const { candidate, source, repair } = params;

  let firstErrors: string[];
  let firstNonconformant = false;
  if (candidate === undefined) {
    firstErrors = ['response carried no "definition" field'];
  } else {
    const validation = validateAppletDefinitionCandidate(candidate, source);
    if (validation.ok) {
      return {
        definition: validation.definition,
        definitionHash: validation.definitionHash,
        diagnostics: conformanceWarningDiagnostics(validation.warnings),
        repaired: false,
      };
    }
    firstErrors = validation.errors;
    firstNonconformant = validation.nonconformant;
  }

  const firstFailureCode = failureCode(candidate === undefined, firstNonconformant);
  if (!repair) {
    return { diagnostics: toDiagnostics(firstFailureCode, firstErrors), repaired: false };
  }

  const messages = buildAppletDefinitionRepairMessages({
    candidate,
    errors: firstErrors,
    source,
  }) as ChatMessage[];

  let response: { content: string | null; usage?: AppletDefinitionUsage };
  try {
    response = await repair(messages);
  } catch {
    return { diagnostics: toDiagnostics(firstFailureCode, firstErrors), repaired: false };
  }

  const usage = response.usage;
  const repairedCandidate =
    response.content != null ? parseRepairedDefinition(response.content) : undefined;
  if (repairedCandidate === undefined) {
    return {
      diagnostics: toDiagnostics(firstFailureCode, firstErrors),
      repaired: false,
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  const repairedValidation = validateAppletDefinitionCandidate(repairedCandidate, source);
  if (!repairedValidation.ok) {
    return {
      diagnostics: toDiagnostics(
        failureCode(false, repairedValidation.nonconformant),
        repairedValidation.errors,
      ),
      repaired: false,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  return {
    definition: repairedValidation.definition,
    definitionHash: repairedValidation.definitionHash,
    diagnostics: conformanceWarningDiagnostics(repairedValidation.warnings),
    repaired: true,
    ...(usage !== undefined ? { usage } : {}),
  };
}
