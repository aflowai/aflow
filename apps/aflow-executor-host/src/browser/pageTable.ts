/**
 * Which pages each run holds.
 *
 * Pages live in memory, as process handles and harness sessions do: an
 * executor restart loses them while the profile keeps its sign-ins on disk. A
 * run reaches only the pages it opened. Another run's page id is answered as
 * one this run never had, because "not yours" would confirm the id exists.
 */
import { randomBytes } from 'node:crypto';

import { BrowserDriverError } from './errors.js';
import type { PageObservations } from './observations.js';
import type { EnginePage, PageSnapshot } from './types.js';

export interface PageOwner {
  readonly tenantId: string;
  readonly runId: string;
}

export interface HeldPage {
  readonly pageId: string;
  readonly ownerKey: string;
  readonly profileId: string;
  readonly page: EnginePage;
  readonly observations: PageObservations;
  lastUrl: string;
  lastTitle: string;
  lastUsedAt: number;
  /** The newest snapshot taken of the page: its references are the ones that resolve. */
  lastSnapshot?: PageSnapshot;
}

/** Pages a run lost, remembered long enough to say where each one was. */
const GONE_PER_RUN = 100;
const GONE_RUNS = 1000;

function ownerKey(owner: PageOwner): string {
  return `${owner.tenantId}\u0000${owner.runId}`;
}

function mintPageId(): string {
  return `pg_${randomBytes(12).toString('base64url')}`;
}

export class PageTable {
  private readonly held = new Map<string, Map<string, HeldPage>>();
  private readonly gone = new Map<string, Map<string, string>>();

  add(
    owner: PageOwner,
    profileId: string,
    page: EnginePage,
    observations: PageObservations,
    url: string,
    now: number,
  ): HeldPage {
    const key = ownerKey(owner);
    const pages = this.held.get(key) ?? new Map<string, HeldPage>();
    this.held.set(key, pages);
    const entry: HeldPage = {
      pageId: mintPageId(),
      ownerKey: key,
      profileId,
      page,
      observations,
      lastUrl: url,
      lastTitle: '',
      lastUsedAt: now,
    };
    pages.set(entry.pageId, entry);
    return entry;
  }

  /** The run's page, or `page_gone` with where it was last, when that is known. */
  get(owner: PageOwner, pageId: string): HeldPage {
    const entry = this.find(owner, pageId);
    if (entry !== undefined) return entry;
    const lastUrl = this.gone.get(ownerKey(owner))?.get(pageId);
    if (lastUrl !== undefined) {
      throw new BrowserDriverError(
        'page_gone',
        `page_gone: page \`${pageId}\` is no longer open — it was closed, sat unused past its ` +
          `profile's idle limit, or its browser stopped. It was last at ${lastUrl}; open that ` +
          'address again to carry on.',
        { pageId, lastUrl },
      );
    }
    throw new BrowserDriverError(
      'page_gone',
      `page_gone: this run has no page \`${pageId}\`. A page belongs to the run that opened it, ` +
        'and none survives the browser executor restarting. Open the address again.',
      { pageId },
    );
  }

  /** The run's page if it is still open, without refusing. */
  find(owner: PageOwner, pageId: string): HeldPage | undefined {
    const entry = this.held.get(ownerKey(owner))?.get(pageId);
    if (entry === undefined) return undefined;
    if (!entry.page.isClosed()) return entry;
    this.forget(entry);
    return undefined;
  }

  list(owner: PageOwner): HeldPage[] {
    return [...(this.held.get(ownerKey(owner))?.values() ?? [])].filter((entry) => {
      if (!entry.page.isClosed()) return true;
      this.forget(entry);
      return false;
    });
  }

  /** Every page held, for the idle sweep. */
  all(): HeldPage[] {
    return [...this.held.values()].flatMap((pages) => [...pages.values()]);
  }

  countForProfile(profileId: string): number {
    return this.all().filter((entry) => entry.profileId === profileId).length;
  }

  /** Every page a profile's browser held, after that browser ended. */
  dropProfile(profileId: string): number {
    const dropped = this.all().filter((entry) => entry.profileId === profileId);
    for (const entry of dropped) this.forget(entry);
    return dropped.length;
  }

  forget(entry: HeldPage): void {
    const pages = this.held.get(entry.ownerKey);
    pages?.delete(entry.pageId);
    if (pages?.size === 0) this.held.delete(entry.ownerKey);
    const gone = this.gone.get(entry.ownerKey) ?? new Map<string, string>();
    gone.set(entry.pageId, entry.lastUrl);
    while (gone.size > GONE_PER_RUN) {
      const oldest = gone.keys().next().value;
      if (oldest === undefined) break;
      gone.delete(oldest);
    }
    this.gone.delete(entry.ownerKey);
    this.gone.set(entry.ownerKey, gone);
    while (this.gone.size > GONE_RUNS) {
      const oldest = this.gone.keys().next().value;
      if (oldest === undefined) break;
      this.gone.delete(oldest);
    }
  }
}
