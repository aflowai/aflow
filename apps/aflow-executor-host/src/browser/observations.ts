/**
 * What a page logged and requested, kept from the moment it was opened, and
 * how a read of it — or of its text — is bounded.
 *
 * Network entries are method, address, status and kind: no body and no header
 * is ever kept, and every query value is replaced before an address is stored,
 * because a query is where tokens travel.
 */
import { BROWSER_READ_DEFAULT_CHARS, BROWSER_READ_MAX_ENTRIES } from '@aflow/schemas';

import { encodedLength, encodedPrefix } from './encodedLength.js';
import type { PageEvents } from './types.js';

/** Messages one page keeps; the oldest go first. */
export const CONSOLE_BUFFER_ENTRIES = 500;
/** Requests one page keeps; the oldest go first. */
export const NETWORK_BUFFER_ENTRIES = 1_000;
/** One console message as stored: a page can log a megabyte in one call. */
export const CONSOLE_TEXT_MAX_CHARS = 4_000;

export interface ConsoleEntry {
  readonly level: string;
  readonly text: string;
  readonly at: string;
}

export interface NetworkEntry {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly failure?: string;
  readonly resourceType: string;
  readonly at: string;
}

export class RingBuffer<T> {
  private readonly held: T[] = [];
  private dropped = 0;

  constructor(readonly capacity: number) {}

  push(item: T): void {
    this.held.push(item);
    if (this.held.length > this.capacity) {
      this.held.shift();
      this.dropped += 1;
    }
  }

  entries(): readonly T[] {
    return this.held;
  }

  /** Entries pushed that the buffer no longer holds. */
  get notRetained(): number {
    return this.dropped;
  }
}

/** An address with its credentials and fragment gone and every query value replaced. */
export function redactUrl(raw: string): string {
  if (/^data:/i.test(raw)) return `${raw.slice(0, Math.max(raw.indexOf(','), 5))},…`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.replace(/[?#].*$/, '');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  const redacted = new URLSearchParams();
  for (const key of url.searchParams.keys()) redacted.append(key, 'redacted');
  url.search = redacted.toString();
  return url.href;
}

export class PageObservations {
  readonly console = new RingBuffer<ConsoleEntry>(CONSOLE_BUFFER_ENTRIES);
  readonly network = new RingBuffer<NetworkEntry>(NETWORK_BUFFER_ENTRIES);

  constructor(private readonly now: () => number) {}

  /** What a page reports, recorded here from the moment it is created. */
  events(): PageEvents {
    return {
      console: (level, text) => {
        this.recordConsole(level, text);
      },
      request: (request) => {
        this.recordRequest(request);
      },
    };
  }

  recordConsole(level: string, text: string): void {
    this.console.push({
      level,
      text:
        text.length > CONSOLE_TEXT_MAX_CHARS ? `${text.slice(0, CONSOLE_TEXT_MAX_CHARS)}…` : text,
      at: new Date(this.now()).toISOString(),
    });
  }

  recordRequest(entry: Omit<NetworkEntry, 'at'>): void {
    this.network.push({
      ...entry,
      url: redactUrl(entry.url),
      at: new Date(this.now()).toISOString(),
    });
  }
}

function matches(text: string, contains: string | undefined): boolean {
  return contains === undefined || text.toLowerCase().includes(contains.toLowerCase());
}

/**
 * The newest matching entries that fit, oldest first, and how many matched
 * but were left out. Newest kept because a read is usually about what just
 * happened. Each entry is counted as it is serialized, with its separator.
 */
export function boundEntries<T>(
  entries: readonly T[],
  contains: string | undefined,
  textOf: (entry: T) => string,
  maxEntries: number = BROWSER_READ_MAX_ENTRIES,
  maxChars: number = BROWSER_READ_DEFAULT_CHARS,
): { kept: T[]; withheld: number } {
  const matched = entries.filter((entry) => matches(textOf(entry), contains));
  const kept: T[] = [];
  let chars = 0;
  for (let i = matched.length - 1; i >= 0 && kept.length < maxEntries; i -= 1) {
    const entry = matched[i] as T;
    const size = JSON.stringify(entry).length + 1;
    if (chars + size > maxChars) break;
    chars += size;
    kept.push(entry);
  }
  return { kept: kept.reverse(), withheld: matched.length - kept.length };
}

export interface BoundedText {
  readonly text: string;
  /** Where in the selected text this window starts. */
  readonly offset: number;
  /** Characters of the selected text after this window. */
  readonly withheld: number;
  /** The offset that reads on, when anything was withheld. */
  readonly nextOffset?: number;
}

/**
 * Page text, filtered to matching lines when asked, from `offset` for as
 * much as the bound holds. Offsets count the selected text's own characters;
 * the bound counts them as the result carries them.
 */
export function boundText(
  text: string,
  contains: string | undefined,
  options: { readonly offset?: number; readonly maxChars?: number } = {},
): BoundedText {
  const selected =
    contains === undefined
      ? text
      : text
          .split('\n')
          .filter((line) => matches(line, contains))
          .join('\n');
  const offset = Math.min(options.offset ?? 0, selected.length);
  const rest = selected.slice(offset);
  const maxChars = options.maxChars ?? BROWSER_READ_DEFAULT_CHARS;
  const shown = encodedLength(rest) <= maxChars ? rest : encodedPrefix(rest, maxChars);
  const withheld = rest.length - shown.length;
  return {
    text: shown,
    offset,
    withheld,
    ...(withheld > 0 ? { nextOffset: offset + shown.length } : {}),
  };
}
