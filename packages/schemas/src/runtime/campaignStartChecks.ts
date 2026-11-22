// ============================================================================
// Campaign start checks
// ============================================================================

/**
 * What a check reads. The `db` field is `unknown` for the reason the runtime
 * validator context gives: the registry does not pull in Drizzle.
 */
export interface CampaignStartCheckContext {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  /** The validated config of the campaign about to be created. */
  config: Record<string, unknown>;
  db: unknown;
}

export type CampaignStartCheckResult =
  { ok: true } | { ok: false; message: string; details?: Record<string, unknown> };

/**
 * A precondition a skill's campaign contract names in `startChecks`, which
 * the space and the services it binds must meet for the campaign to run.
 * Campaign start runs every check before it creates the campaign, so a
 * refusal creates nothing. It changes nothing in the space.
 */
export type CampaignStartCheckFn = (
  ctx: CampaignStartCheckContext,
) => Promise<CampaignStartCheckResult>;

const _checks = new Map<string, CampaignStartCheckFn>();

export function registerCampaignStartCheck(name: string, fn: CampaignStartCheckFn): void {
  const existing = _checks.get(name);
  if (existing && existing !== fn) {
    throw new Error(
      `campaignStartChecks: "${name}" is already registered with a different function.`,
    );
  }
  _checks.set(name, fn);
}

export function getCampaignStartCheck(name: string): CampaignStartCheckFn | null {
  return _checks.get(name) ?? null;
}

export function listCampaignStartCheckNames(): string[] {
  return [..._checks.keys()].sort();
}
