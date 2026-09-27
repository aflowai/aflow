/**
 * The rehearsal link — one writer for what a chat URL carries.
 *
 * Two surfaces have to agree on it: the panel that builds the link and the
 * chat page that reads it. Spelled separately they drift, and the way they
 * drift is silent — a parameter renamed on one side leaves the other pinning
 * nothing, and the desk answers as the default persona while the URL says
 * otherwise. That is the one failure a transcript cannot show.
 */

/** Acting as nobody — the unauthenticated caller, which is its own scenario. */
export const NOBODY_PERSONA = '__nobody__';

export interface RehearsalPin {
  simulationId: string;
  /** `null` acts as nobody. */
  personaId: string | null;
  baselineVersion?: number;
}

export function rehearsalSearchParams(pin: RehearsalPin & { agentId?: string }): URLSearchParams {
  const params = new URLSearchParams();
  if (pin.agentId) params.set('agentId', pin.agentId);
  params.set('sim', pin.simulationId);
  params.set('persona', pin.personaId ?? NOBODY_PERSONA);
  if (pin.baselineVersion !== undefined) params.set('baseline', String(pin.baselineVersion));
  return params;
}

/**
 * The run input a rehearsal link pins, or `undefined` when the URL carries no
 * rehearsal at all — which is every ordinary chat, and the reason this costs
 * nothing to have on the chat page.
 */
export function rehearsalRunInput(params: {
  sim: string | null;
  persona: string | null;
  baseline: string | null;
}):
  | { personaIds: Record<string, string | null>; baselineVersions?: Record<string, number> }
  | undefined {
  if (!params.sim || !params.persona) return undefined;
  const baselineVersion = Number(params.baseline);
  return {
    personaIds: {
      [params.sim]: params.persona === NOBODY_PERSONA ? null : params.persona,
    },
    ...(Number.isInteger(baselineVersion) && baselineVersion > 0
      ? { baselineVersions: { [params.sim]: baselineVersion } }
      : {}),
  };
}
