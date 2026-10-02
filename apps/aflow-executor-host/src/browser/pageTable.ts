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
import type { EnginePage } from './types.js';

export interface PageOwner {
  readonly tenantId: string;
  readonly runId: string;
}

export interface HeldPage {
  readonly pageId: string;
  readonly profileId: string;
  readonly page: EnginePage;
  lastUrl: string;
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

  add(owner: PageOwner, profileId: string, page: EnginePage, url: string): HeldPage {
    const key = ownerKey(owner);
    const pages = this.held.get(key) ?? new Map<string, HeldPage>();
    this.held.set(key, pages);
    const entry: HeldPage = { pageId: mintPageId(), profileId, page, lastUrl: url };
    pages.set(entry.pageId, entry);
    return entry;
  }

  /** The run's page, or `page_gone` with where it was last, when that is known. */
  get(owner: PageOwner, pageId: string): HeldPage {
    const key = ownerKey(owner);
    const entry = this.held.get(key)?.get(pageId);
    if (entry !== undefined && !entry.page.isClosed()) return entry;
    if (entry !== undefined) this.forget(key, entry);
    const lastUrl = this.gone.get(key)?.get(pageId);
    if (lastUrl !== undefined) {
      throw new BrowserDriverError(
        'page_gone',
        `page_gone: page \`${pageId}\` is no longer open — its browser stopped or the page ` +
          `closed. It was last at ${lastUrl}; open that address again to carry on.`,
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

  remove(owner: PageOwner, pageId: string): void {
    const key = ownerKey(owner);
    const entry = this.held.get(key)?.get(pageId);
    if (entry !== undefined) this.forget(key, entry);
  }

  /** Every page a profile's browser held, after that browser ended. */
  dropProfile(profileId: string): number {
    let dropped = 0;
    for (const [key, pages] of this.held) {
      for (const entry of [...pages.values()]) {
        if (entry.profileId !== profileId) continue;
        this.forget(key, entry);
        dropped += 1;
      }
    }
    return dropped;
  }

  private forget(key: string, entry: HeldPage): void {
    const pages = this.held.get(key);
    pages?.delete(entry.pageId);
    if (pages?.size === 0) this.held.delete(key);
    const gone = this.gone.get(key) ?? new Map<string, string>();
    gone.set(entry.pageId, entry.lastUrl);
    while (gone.size > GONE_PER_RUN) {
      const oldest = gone.keys().next().value;
      if (oldest === undefined) break;
      gone.delete(oldest);
    }
    this.gone.delete(key);
    this.gone.set(key, gone);
    while (this.gone.size > GONE_RUNS) {
      const oldest = this.gone.keys().next().value;
      if (oldest === undefined) break;
      this.gone.delete(oldest);
    }
  }
}
