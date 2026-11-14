import type { SessionHotState } from '@aflow/redis';
import { getVariableVersion, readInlineVar, writeInlineVar } from '../helpers/runtimeState.js';
import {
  evaluateLoopTurn,
  loopVarKeys,
  type LoopTurnVerdict,
  type ResolveCallOperation,
  type SignatureCall,
} from './callSignature.js';

type RuntimeState = NonNullable<SessionHotState['runtimeState']>;

export interface LoopTurnStateUpdate {
  verdict: LoopTurnVerdict;
  /** The step's variables with both windows and each rule's pending warning written. */
  variables: Record<string, unknown>;
  /** One log entry per warning a rule wrote this turn. */
  warningLogs: Array<{ label: string; detail: string }>;
}

/**
 * Runs both loop rules over one agent turn's calls and writes what they
 * leave for the next turn. Each rule owns its own warning variable, so a
 * turn that trips one rule leaves the other rule's warning cleared.
 */
export function applyLoopTurn(
  runtimeState: RuntimeState,
  stepId: string,
  calls: readonly SignatureCall[],
  resolveOperation: ResolveCallOperation,
  meta: { nowMs: number; stepExecutionId: string },
): LoopTurnStateUpdate {
  const keys = loopVarKeys(stepId);
  const verdict = evaluateLoopTurn(
    {
      recentSignatures: readInlineVar(runtimeState, keys.recentSignatures, [] as string[]),
      recentReadTargets: readInlineVar(runtimeState, keys.recentReadTargets, [] as string[][]),
    },
    calls,
    resolveOperation,
  );
  const varMeta = { ...meta, stepId };
  const variables = { ...runtimeState.variables };
  writeInlineVar(variables, keys.recentSignatures, verdict.state.recentSignatures, {
    ...varMeta,
    version: verdict.state.recentSignatures.length,
  });
  writeInlineVar(variables, keys.recentReadTargets, verdict.state.recentReadTargets, {
    ...varMeta,
    version: verdict.state.recentReadTargets.length,
  });
  const warningLogs: LoopTurnStateUpdate['warningLogs'] = [];
  const ruleWarnings = [
    { varKey: keys.identicalCallWarning, logLabel: 'Loop warning', logged: verdict.identicalCall },
    {
      varKey: keys.sameTargetWarning,
      logLabel: 'Same-target read warning',
      logged: verdict.sameTarget,
    },
  ];
  for (const { varKey, logLabel, logged } of ruleWarnings) {
    delete variables[varKey];
    if (logged === undefined) continue;
    writeInlineVar(variables, varKey, logged.warning, {
      ...varMeta,
      version: getVariableVersion(runtimeState.variables[varKey]) + 1,
    });
    warningLogs.push({ label: logLabel, detail: logged.logDetail });
  }
  return { verdict, variables, warningLogs };
}
