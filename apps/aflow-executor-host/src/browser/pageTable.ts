/**
 * Which pages each run holds.
 *
 * Pages live in memory, as process handles and harness sessions do: an
 * executor restart loses them while the profile keeps its sign-ins on disk. A
 * run reaches only the pages it opened. Another run's page id is answered as
 * one this run never had, because "not yours" would confirm the id exists.
 */
import { randomBytes } from 'node:crypto';

import type { ApprovalStore } from './actionApproval.js';
import { BrowserDriverError } from './errors.js';
import { type PageObservations, redactUrl } from './observations.js';
import type { EnginePage, PageSnapshot } from './types.js';

export interface PageOwner {
  readonly tenantId: string;
  readonly runId: string;
}

/**
 * An action on a page parked for the operator's answer. The idle sweep holds
 * the page until the answer is on record or the request no longer stands: the
 * page is in the request hash, so an approval reaching a closed page would
 * find nothing to act on.
 */
export interface PendingAsk {
  readonly owner: PageOwner;
  readonly store: Pick<ApprovalStore, 'grant'>;
  readonly standsUntil: number;
  /** When the decision already on record for the request was made; an answer is a newer one. */
  readonly decidedBefore: string | undefined;
}

export interface HeldPage {
  readonly pageId: string;
  readonly ownerKey: string;
  readonly profileId: string;
  /** The opening run's space: the page stays open only while its profile serves it. */
  readonly spaceId: string | undefined;
  readonly page: EnginePage;
  readonly observations: PageObservations;
  /** The address the open asked for, as a URL spells it. */
  readonly requestedUrl: string;
  /**
   * The address this run last gave the page, by open or navigate. It is shown
   * whole because the run wrote it; where the page went on its own is not.
   */
  askedUrl: string;
  /** Where the page was when last looked at, as `pageAddress` shows it. */
  lastUrl: string;
  lastTitle: string;
  lastUsedAt: number;
  /** The newest snapshot taken of the page: its references are the ones that resolve. */
  lastSnapshot?: PageSnapshot;
  /** Asks parked on this page, by request hash. */
  readonly pendingAsks: Map<string, PendingAsk>;
}

/**
 * Where the page is now, as it may leave this machine, recorded as its last
 * address. A landing page's own address carries the codes and tokens a
 * sign-in hands back, so it takes the rule every request the page makes takes.
 */
export function pageAddress(held: Pick<HeldPage, 'page' | 'lastUrl'>): string {
  held.lastUrl = redactUrl(held.page.url());
  return held.lastUrl;
}

/** Where a page a run lost was, and what that run last asked it to load. */
export interface GonePage {
  readonly lastUrl: string;
  readonly askedUrl?: string;
  /** Why it went, when the host knows better than `get`'s general account. */
  readonly why?: string;
}

/**
 * `page_gone` for a page that was open. The last address has its query values
 * replaced, so loading it as written is not what the run wants; the address
 * the run itself asked for is what it can open again.
 */
export function pageGoneError(pageId: string, why: string, gone: GonePage): BrowserDriverError {
  const { lastUrl, askedUrl } = gone;
  const again =
    askedUrl !== undefined
      ? `It was last at ${lastUrl}. The address this run last asked it for was ${askedUrl}; ` +
        'open that again to carry on.'
      : `It was last at ${lastUrl}, its query values withheld, so that address does not load ` +
        'as written; open the page again from an address this run knows.';
  return new BrowserDriverError(
    'page_gone',
    `page_gone: page \`${pageId}\` is no longer open — ${why}. ${again}`,
    { pageId, lastUrl, ...(askedUrl !== undefined ? { askedUrl } : {}) },
  );
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

/** How long the host waits on a page it closes itself before it lets the page go regardless. */
export const PAGE_CLOSE_DEADLINE_MS = 5_000;

/**
 * Close a page — revoked, idle, or closed by its run. A page that does not
 * answer is abandoned at the deadline: what waits on it is the rest of a
 * policy change, a sweep, or the run's step, and one hung page must not hold
 * any of them up.
 */
export async function closeWithinDeadline(page: EnginePage): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PAGE_CLOSE_DEADLINE_MS);
  });
  try {
    await Promise.race([page.close().catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export class PageTable {
  private readonly held = new Map<string, Map<string, HeldPage>>();
  private readonly gone = new Map<string, Map<string, GonePage>>();

  add(
    owner: PageOwner & { readonly spaceId?: string },
    profileId: string,
    requestedUrl: string,
    page: EnginePage,
    observations: PageObservations,
    now: number,
  ): HeldPage {
    const key = ownerKey(owner);
    const pages = this.held.get(key) ?? new Map<string, HeldPage>();
    this.held.set(key, pages);
    const entry: HeldPage = {
      pageId: mintPageId(),
      ownerKey: key,
      profileId,
      spaceId: owner.spaceId,
      requestedUrl,
      askedUrl: requestedUrl,
      page,
      observations,
      lastUrl: '',
      lastTitle: '',
      lastUsedAt: now,
      pendingAsks: new Map(),
    };
    pageAddress(entry);
    pages.set(entry.pageId, entry);
    return entry;
  }

  /** The run's page, or `page_gone` with where it was last, when that is known. */
  get(owner: PageOwner, pageId: string): HeldPage {
    const entry = this.find(owner, pageId);
    if (entry !== undefined) return entry;
    const gone = this.gone.get(ownerKey(owner))?.get(pageId);
    if (gone !== undefined) {
      throw pageGoneError(
        pageId,
        gone.why ??
          "it was closed, sat unused past its profile's idle limit, or its browser stopped",
        gone,
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
  dropProfile(profileId: string, why?: string): number {
    const dropped = this.all().filter((entry) => entry.profileId === profileId);
    for (const entry of dropped) this.forget(entry, why);
    return dropped.length;
  }

  forget(entry: HeldPage, why?: string): void {
    const pages = this.held.get(entry.ownerKey);
    pages?.delete(entry.pageId);
    if (pages?.size === 0) this.held.delete(entry.ownerKey);
    const gone = this.gone.get(entry.ownerKey) ?? new Map<string, GonePage>();
    gone.set(entry.pageId, {
      lastUrl: entry.lastUrl,
      askedUrl: entry.askedUrl,
      ...(why !== undefined ? { why } : {}),
    });
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
