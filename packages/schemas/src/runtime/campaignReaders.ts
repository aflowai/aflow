// ============================================================================
// Campaign readers
// ============================================================================

/**
 * What a reader reads. The `db` field is `unknown` for the reason the runtime
 * validator context gives: the registry does not pull in Drizzle.
 */
export interface CampaignReaderContext {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  /** The campaign's config as it stands. */
  config: Record<string, unknown>;
  /** When the campaign started, ISO 8601. */
  startedAt: string;
  /** The arguments the `workflow.campaign.read` call passed. */
  args: Record<string, unknown>;
  db: unknown;
}

export type CampaignReaderResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/**
 * A deterministic read over what a campaign's runs stored in the space, named
 * by `workflow.campaign.read`. It reads every stored doc it needs and gives
 * the value, so a skill binds the stored record itself and never an agent's
 * copy of it. It changes nothing in the space.
 */
export type CampaignReaderFn = (ctx: CampaignReaderContext) => Promise<CampaignReaderResult>;

const _readers = new Map<string, CampaignReaderFn>();

export function registerCampaignReader(name: string, fn: CampaignReaderFn): void {
  const existing = _readers.get(name);
  if (existing && existing !== fn) {
    throw new Error(`campaignReaders: "${name}" is already registered with a different function.`);
  }
  _readers.set(name, fn);
}

export function getCampaignReader(name: string): CampaignReaderFn | null {
  return _readers.get(name) ?? null;
}

export function listCampaignReaderNames(): string[] {
  return [..._readers.keys()].sort();
}
