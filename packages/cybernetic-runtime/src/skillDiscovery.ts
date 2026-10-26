import { createHash } from 'node:crypto';
import { resolveWorkflowForStart } from '@aflow/database';
import { loadSkill } from './skill.js';
import { resolveCurrentSkillReadiness } from './skillProjectionReconciler.js';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  querySkillDiscovery,
} from '@aflow/database';
import {
  INSTALLED_SKILLS_GUIDANCE,
  DirectiveCapabilityDiscoverySchema,
  skillPlacement,
  skillAwarenessEntry,
  skillAwarenessTokens,
  skillUsageSummary,
  estimateStringTokens,
  SKILL_AWARENESS_TOKEN_BUDGET,
  SKILL_SEARCH_TOKEN_BUDGET,
  type TenantId,
  type SkillSearchInput,
  type SkillDiscoveryEntry,
  type SkillUsageSummary,
} from '@aflow/schemas';

export interface SkillDiscoveryContext {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}

export async function loadHelmsmanDiscovery(ctx: SkillDiscoveryContext) {
  const rows = await withTenantSchema(
    ctx.db,
    createTenantContext(ctx.tenantId as TenantId),
    async (tx) =>
      tx
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eq(spaces.id, ctx.spaceId))
        .limit(1),
  );
  const directives = rows[0]?.directives as { capabilityDiscovery?: unknown } | null | undefined;
  const parsed = DirectiveCapabilityDiscoverySchema.safeParse(
    directives?.capabilityDiscovery ?? {},
  );
  return parsed.success ? parsed.data : {};
}

export async function searchInstalledSkills(
  ctx: SkillDiscoveryContext,
  input: SkillSearchInput,
  includeOff = false,
) {
  const discovery = await loadHelmsmanDiscovery(ctx);
  const excludedSlugs = includeOff
    ? []
    : Object.entries(discovery.skillPlacements ?? {})
        .filter(([, value]) => value === 'off')
        .map(([slug]) => slug);
  const queryHash = createHash('sha256').update(input.query).digest('hex');
  const cursorFor = (offset: number) =>
    Buffer.from(JSON.stringify({ offset, queryHash })).toString('base64url');
  const guidance =
    'Pick by each skill’s usage — whenToUse, whenNotToUse, and next for what follows it. Inspect the selected skill with the suggested invocation call for its current validity, readiness, input contracts and pitfalls, then use workflow.run.start. No tool promotion is needed. Search again by purpose if no match fits.';
  let offset = 0;
  if (input.cursor) {
    const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) as {
      offset?: unknown;
      queryHash?: unknown;
    };
    if (
      !Number.isSafeInteger(cursor.offset) ||
      Number(cursor.offset) < 0 ||
      cursor.queryHash !== queryHash
    )
      throw new Error('Invalid skill search cursor. Restart the search.');
    offset = Number(cursor.offset);
  }
  const found = await querySkillDiscovery(ctx.db, ctx.tenantId as TenantId, ctx.spaceId, {
    query: input.query,
    offset,
    limit: input.limit,
    excludedSlugs,
  });
  const skills: Array<
    Omit<SkillDiscoveryEntry, 'usage'> & {
      usage?: SkillUsageSummary;
      usageOmitted?: boolean;
      descriptionOmitted?: boolean;
      readiness?: {
        canRun: boolean;
        contractValid: boolean;
        activationStatus: string;
        missingCapabilities: string[];
        missingCapabilityCount?: number;
      };
      placement: ReturnType<typeof skillPlacement>;
      suggestedInspectCall: {
        operation: 'workflow.manage.get';
        input: { slug: string; view: 'invocation' };
      };
    }
  > = [];
  const responseEnvelope = {
    total: found.total,
    returned: input.limit,
    nextCursor: cursorFor(found.total),
    guidance,
  };
  for (const entry of found.skills) {
    const workflow = !includeOff
      ? await resolveWorkflowForStart(ctx.db, ctx.tenantId as TenantId, ctx.spaceId, entry.slug)
      : null;
    const skill = workflow ? await loadSkill(ctx, entry.slug) : null;
    const readiness = workflow
      ? await resolveCurrentSkillReadiness(
          ctx,
          workflow,
          skill?.manifest.requiredCapabilities,
          skill?.projection?.status,
        )
      : undefined;
    const { usage: fullUsage, ...listed } = entry;
    const usage = skillUsageSummary(fullUsage);
    let result: (typeof skills)[number] = {
      ...listed,
      ...(usage ? { usage } : {}),
      ...(readiness
        ? {
            readiness: {
              canRun: readiness.canRun,
              contractValid: readiness.contractValid,
              activationStatus: readiness.activationStatus,
              missingCapabilities: readiness.missingCapabilities,
            },
          }
        : {}),
      placement: skillPlacement(entry.slug, discovery.skillPlacements),
      suggestedInspectCall: {
        operation: 'workflow.manage.get' as const,
        input: { slug: entry.slug, view: 'invocation' as const },
      },
    };
    const responseTokens = (candidate: typeof result): number =>
      estimateStringTokens(JSON.stringify({ ...responseEnvelope, skills: [...skills, candidate] }));
    if (responseTokens(result) > SKILL_SEARCH_TOKEN_BUDGET && skills.length === 0) {
      result = {
        ...result,
        description: '',
        descriptionOmitted: true,
        ...(result.readiness
          ? {
              readiness: {
                ...result.readiness,
                missingCapabilities: [],
                missingCapabilityCount: result.readiness.missingCapabilities.length,
              },
            }
          : {}),
      };
    }
    // Past the description, what to pick the skill by is the last thing
    // given up: its whenToUse survives on its own before the usage goes.
    if (responseTokens(result) > SKILL_SEARCH_TOKEN_BUDGET && skills.length === 0 && result.usage) {
      const { usage: wide, ...rest } = result;
      result = wide.whenToUse ? { ...rest, usage: { whenToUse: wide.whenToUse } } : rest;
      if (responseTokens(result) > SKILL_SEARCH_TOKEN_BUDGET) {
        const { usage: _dropped, ...bare } = result;
        result = { ...bare, usageOmitted: true };
      }
    }
    if (responseTokens(result) > SKILL_SEARCH_TOKEN_BUDGET) {
      if (skills.length) break;
      throw new Error(
        'This skill’s discovery metadata exceeds the response budget; repair its name or slug before searching again.',
      );
    }
    skills.push(result);
  }
  const nextOffset = offset + skills.length;
  return {
    skills,
    total: found.total,
    returned: skills.length,
    ...(nextOffset < found.total
      ? {
          nextCursor: cursorFor(nextOffset),
        }
      : {}),
    guidance,
  };
}

export async function buildInstalledSkillAwareness(
  ctx: SkillDiscoveryContext,
  placements: Record<string, string> = {},
) {
  const excludedSlugs = Object.entries(placements)
    .filter(([, p]) => p === 'off')
    .map(([slug]) => slug);
  const pinnedSlugs = Object.entries(placements)
    .filter(([, p]) => p === 'always_on')
    .map(([slug]) => slug);
  const [library, pinned] = await Promise.all([
    querySkillDiscovery(ctx.db, ctx.tenantId as TenantId, ctx.spaceId, { limit: 0, excludedSlugs }),
    querySkillDiscovery(ctx.db, ctx.tenantId as TenantId, ctx.spaceId, {
      onlySlugs: pinnedSlugs,
      limit: pinnedSlugs.length,
    }),
  ]);
  const active = [];
  let tokens = 0;
  for (const entry of pinned.skills) {
    const summary = skillAwarenessEntry(entry);
    const cost = estimateStringTokens(JSON.stringify(summary));
    if (tokens + cost > SKILL_AWARENESS_TOKEN_BUDGET) continue;
    active.push(summary);
    tokens += cost;
  }
  const omittedPinnedCount = pinned.skills.length - active.length;
  return {
    pinned: active,
    pinnedTokens: tokens,
    total: library.total,
    ...(omittedPinnedCount ? { truncated: true, omittedPinnedCount } : {}),
    onDemandCount: library.total - pinned.skills.length,
    guidance:
      (omittedPinnedCount
        ? `${String(omittedPinnedCount)} pinned skill summaries exceed the context budget after revisions; find them through search and move some to on demand in settings. `
        : '') + INSTALLED_SKILLS_GUIDANCE,
  };
}

export async function validatePinnedSkillBudget(
  ctx: SkillDiscoveryContext,
  placements: Record<string, string> = {},
): Promise<number> {
  const onlySlugs = Object.entries(placements)
    .filter(([, p]) => p === 'always_on')
    .map(([slug]) => slug);
  const pinned = await querySkillDiscovery(ctx.db, ctx.tenantId as TenantId, ctx.spaceId, {
    onlySlugs,
    limit: onlySlugs.length,
  });
  return skillAwarenessTokens(pinned.skills);
}
