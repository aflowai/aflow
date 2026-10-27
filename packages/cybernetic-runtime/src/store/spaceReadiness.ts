/**
 * Readiness as the three surfaces read it (Plan 330 D4): the bundle install,
 * the Store page and the space's help surface. Each answer is the derived
 * post-install manifest — `generatePostInstallManifest`, handed a space
 * template's items where the space was made from one — so a state change
 * reads the same wherever it is read.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { getCatalogEntry, getSkillBundleEntry } from '@aflow/platform-artifacts';
import {
  postInstallReadiness,
  postInstallTaskState,
  type CatalogEntry,
  type ComposedLanes,
  type HelpArticleId,
  type PostInstallTask,
  type PostInstallTaskState,
  type SkillBundle,
  type SpaceReadinessEntry,
  type SpaceTemplate,
  type SpaceTemplateReadinessItem,
} from '@aflow/schemas';
import {
  bundleReadsGithub,
  generatePostInstallManifest,
  readingsForItems,
} from '../stagedChange/bundleInstallManifest.js';
import type { GithubAnswers } from './readinessReaders.js';
import { listStoreInstalls } from './storeInstallProvenance.js';

export interface ReadinessContext {
  tenantId: string;
  spaceId: string;
  redis?: Redis | null | undefined;
  lanes?: Pick<ComposedLanes, 'hostLane'> | undefined;
  /** GitHub's answers, asked before the caller's transaction (`askGithubForSpace`). */
  githubAnswers?: GithubAnswers | undefined;
}

export interface SpaceReadiness {
  status: 'ready' | 'needs_setup' | 'broken';
  tasks: PostInstallTask[];
}

export interface TemplateReadiness extends SpaceReadiness {
  readiness: SpaceReadinessEntry[];
}

/** The bundle whose Store listing shows its readiness: the coding loop's. */
const READINESS_LISTED_BUNDLES = new Set(['coding-loop']);

const STATE_RANK: Record<PostInstallTaskState, number> = { done: 0, needs_setup: 1, broken: 2 };

/** Tasks two bundles both derived, listed once. */
function dedupeTasks(tasks: readonly PostInstallTask[]): PostInstallTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = JSON.stringify(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Each template item as the manifest reads it: the state of the task that
 * answers it (the worst, where two do), and `done` where none is listed — a
 * kind listed only while unmet is met once it is gone.
 */
export function readSpaceTemplateReadiness(
  items: readonly SpaceTemplateReadinessItem[],
  tasks: readonly PostInstallTask[],
): SpaceReadinessEntry[] {
  return items.map((item) => {
    const answering = tasks.filter(
      (task) =>
        task.kind === item.answeredBy &&
        (item.reading === undefined ||
          (task.kind === 'pair_machine' && task.reading === item.reading)),
    );
    const state = answering
      .map(postInstallTaskState)
      .reduce<PostInstallTaskState>(
        (worst, next) => (STATE_RANK[next] > STATE_RANK[worst] ? next : worst),
        'done',
      );
    return {
      key: item.key,
      title: item.title,
      required: item.required,
      state,
      ...(item.page !== undefined ? { page: item.page } : {}),
      ...(item.command !== undefined ? { command: item.command } : {}),
    };
  });
}

/** One bundle's readiness in a space: its derived manifest and the verdict on it. */
export async function readBundleReadiness(
  tx: PostgresJsDatabase,
  bundle: SkillBundle,
  ctx: ReadinessContext,
): Promise<SpaceReadiness> {
  const tasks = await generatePostInstallManifest({ tx, bundle, ...ctx });
  return { status: postInstallReadiness(tasks), tasks };
}

/** A space template's readiness in a space: every bundle's manifest, read with the template's items. */
export async function readTemplateReadiness(
  tx: PostgresJsDatabase,
  template: SpaceTemplate,
  ctx: ReadinessContext,
): Promise<TemplateReadiness> {
  const tasks: PostInstallTask[] = [];
  for (const bundleId of template.bundleIds) {
    const bundle = getSkillBundleEntry(bundleId);
    if (bundle === null) continue;
    tasks.push(
      ...(await generatePostInstallManifest({ tx, bundle, readiness: template.readiness, ...ctx })),
    );
  }
  const setup = dedupeTasks(tasks);
  return {
    status: postInstallReadiness(setup),
    tasks: setup,
    readiness: readSpaceTemplateReadiness(template.readiness, setup),
  };
}

/**
 * What the Store page shows of a listing's readiness in this space: the coding
 * loop's bundle in any space, and a quick start in the space made from it.
 * `null` where the listing shows none.
 */
export async function readListingReadiness(
  tx: PostgresJsDatabase,
  entry: CatalogEntry,
  ctx: ReadinessContext,
): Promise<SpaceReadiness | TemplateReadiness | null> {
  if (entry.kind === 'bundle' && READINESS_LISTED_BUNDLES.has(entry.catalogId)) {
    const bundle = getSkillBundleEntry(entry.catalogId);
    return bundle === null ? null : readBundleReadiness(tx, bundle, ctx);
  }
  if (entry.kind === 'space') {
    const installs = await listStoreInstalls(tx, ctx.spaceId);
    if (!installs.some((install) => install.catalogId === entry.catalogId)) return null;
    return readTemplateReadiness(tx, entry.payload, ctx);
  }
  return null;
}

export interface SpaceHelpReadiness extends TemplateReadiness {
  catalogId: string;
  name: string;
  help: HelpArticleId[];
}

/**
 * Whether a quick start's readiness reads the space's github credential — an
 * item answered by it, or the coding loop's bundle, which reads it itself — so
 * a caller asks GitHub before the readiness read only where an answer is read.
 */
export function templateReadsGithub(template: SpaceTemplate): boolean {
  return (
    template.bundleIds.some(bundleReadsGithub) ||
    readingsForItems(template.readiness).has('github_credential')
  );
}

/** Whether any quick start the space was made from reads its github credential. */
export async function spaceHelpReadsGithub(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<boolean> {
  for (const install of await listStoreInstalls(tx, spaceId)) {
    if (install.kind !== 'space') continue;
    const entry = getCatalogEntry(install.catalogId);
    if (entry?.kind === 'space' && templateReadsGithub(entry.payload)) return true;
  }
  return false;
}

/** The space's help surface: the readiness of each quick start the space was made from. */
export async function readSpaceHelpReadiness(
  tx: PostgresJsDatabase,
  ctx: ReadinessContext,
): Promise<SpaceHelpReadiness[]> {
  const out: SpaceHelpReadiness[] = [];
  for (const install of await listStoreInstalls(tx, ctx.spaceId)) {
    if (install.kind !== 'space') continue;
    const entry = getCatalogEntry(install.catalogId);
    if (entry?.kind !== 'space') continue;
    out.push({
      catalogId: entry.catalogId,
      name: entry.name,
      help: [...entry.payload.help],
      ...(await readTemplateReadiness(tx, entry.payload, ctx)),
    });
  }
  return out;
}
