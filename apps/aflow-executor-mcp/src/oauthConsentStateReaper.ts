/**
 * Delete OAuth consent-state rows past their expiry.
 *
 * The table is cross-kind — API connector consents and MCP server consents are
 * the same rows since the integration unification — so this reaps for the whole
 * integration surface and merely happens to be hosted here.
 *
 * Candidates come from the consent-state due pointer: a consent row is written
 * once, at the start of a consent flow, and deleted when it completes, so the
 * steady state is that no tenant has one. Asking every tenant schema whether it
 * does cost one query per tenant every five minutes to learn nothing; the
 * pointer makes the empty case a single indexed read.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  claimDueTenants,
  releaseTenantDueClaim,
  settleTenantDue,
  OAUTH_STATE_DUE_POINTER,
} from '@aflow/database';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane } from '@aflow/schemas';
import { reapExpiredOauthState } from '@aflow/oauth';

export const OAUTH_CONSENT_STATE_REAPER_TASK_ID = 'executor.oauth.consent_state_reaper';

export interface OauthConsentStateReaperDeps {
  sqlClient: postgres.Sql;
  db: PostgresJsDatabase;
  log: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
}

export function createOauthConsentStateReaper(
  deps: OauthConsentStateReaperDeps,
): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(OAUTH_CONSENT_STATE_REAPER_TASK_ID);
  return createBackgroundTaskRunner(
    {
      taskId: OAUTH_CONSENT_STATE_REAPER_TASK_ID,
      scope: runtime.scope,
      intervalMs: runtime.intervalMs ?? 300_000,
      maxBatch: runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
    },
    async (ctx): Promise<BackgroundTaskCycleResult> => {
      const claimToken = randomUUID();
      const claimed = await claimDueTenants(deps.sqlClient, OAUTH_STATE_DUE_POINTER, {
        limit: ctx.maxBatch,
        leaseMs: runtime.maxCycleMs,
        claimToken,
      });
      if (claimed.length === 0) return { candidates: 0 };
      if (ctx.mode === 'observe') {
        for (const claim of claimed) {
          await releaseTenantDueClaim(
            deps.sqlClient,
            OAUTH_STATE_DUE_POINTER,
            claim.tenantId,
            claimToken,
          );
        }
        return { candidates: claimed.length };
      }

      let deleted = 0;
      let failed = 0;
      for (const claim of claimed) {
        if (ctx.budgetExhausted()) {
          await releaseTenantDueClaim(
            deps.sqlClient,
            OAUTH_STATE_DUE_POINTER,
            claim.tenantId,
            claimToken,
          );
          continue;
        }
        try {
          deleted += await reapExpiredOauthState(claim.tenantId, deps.db);
        } catch (err) {
          failed++;
          deps.log.warn('[oauth-consent-reaper] tenant reap failed', {
            tenantId: claim.tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          await settleTenantDue(deps.sqlClient, OAUTH_STATE_DUE_POINTER, claim, claimToken);
        } catch (err) {
          deps.log.warn('[oauth-consent-reaper] settle failed', {
            tenantId: claim.tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (deleted > 0 || backgroundWorkVerboseLogsEnabled()) {
        deps.log.info('[oauth-consent-reaper] cleared expired consent state', {
          tenants: claimed.length,
          deleted,
        });
      }

      return {
        candidates: claimed.length,
        processed: claimed.length - failed,
        failed,
        hasMore: claimed.length === ctx.maxBatch,
      };
    },
  );
}
