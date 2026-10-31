/**
 * Enter the space this visitor last used.
 *
 * Resolved server-side because a front door sits outside the provider tree that
 * `useSpace()` needs, and because the answer is then known before the first byte
 * reaches the browser.
 */
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { readRefusalCode } from '@aflow/web-product';
import { getPreferredSpaceSlug } from './preferredSpace.js';

/** How the space lookup ended, for a caller that reports it. */
export type SpaceLookupOutcome =
  | { kind: 'slugs'; slugs: string[] }
  | { kind: 'no-credential' }
  | { kind: 'unreachable'; detail: string }
  /** `code` is the refusal body's own, such as the local edition's `PROFILE_SESSION_REQUIRED`. */
  | { kind: 'refused'; status: number; code: string | null };

/** How a caller reaches the API on behalf of the process. */
export interface SpaceLookup {
  apiUrl: string;
  /** `null` means no credential can be had, so the call is not made at all. */
  headers: () => Promise<Record<string, string> | null>;
  report?: (outcome: SpaceLookupOutcome) => void;
  /**
   * What to show when the API refuses the lookup, in place of entering a
   * space. `null` enters the space as before. The local edition answers a
   * missing profile session with its picker here (Plan 335 P3).
   */
  answerRefusal?: (refusal: SpaceLookupRefusal) => Promise<ReactNode | null>;
}

export type SpaceLookupRefusal = Extract<SpaceLookupOutcome, { kind: 'refused' }>;

interface SpaceSummary {
  slug?: unknown;
  myRole?: unknown;
}

async function lookUpSpaces(lookup: SpaceLookup): Promise<SpaceLookupOutcome> {
  const headers = await lookup.headers();
  if (headers === null) return { kind: 'no-credential' };
  let response: Response;
  try {
    response = await fetch(`${lookup.apiUrl}/v1/spaces`, { headers, cache: 'no-store' });
  } catch (error) {
    return { kind: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    return { kind: 'refused', status: response.status, code: await readRefusalCode(response) };
  }
  const body = (await response.json()) as { spaces?: SpaceSummary[] };
  return {
    kind: 'slugs',
    slugs: (body.spaces ?? [])
      // A tenant admin lists every space, and one they are not a member of
      // comes back as a name only. Entering it would land on the not-found
      // state, as another local profile's space would for the owner.
      .filter((space) => space.myRole !== null)
      .map((space) => space.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug !== ''),
  };
}

/** Slugs this caller can reach, or `null` when the question could not be asked. */
async function reachableSlugs(lookup: SpaceLookup): Promise<string[] | null> {
  const outcome = await lookUpSpaces(lookup);
  lookup.report?.(outcome);
  return outcome.kind === 'slugs' ? outcome.slugs : null;
}

/**
 * `null` for the reachable set means the question could not be asked, where an
 * empty set is an answer: this visitor reaches no space, and the hint names one
 * they have lost.
 */
export function chooseSpaceSlug(hinted: string | null, reachable: string[] | null): string | null {
  if (reachable === null) return hinted;
  if (hinted !== null && reachable.includes(hinted)) return hinted;
  return reachable[0] ?? null;
}

/** Where entering a space would lead, or `null` when none resolves. */
export async function resolveSpaceEntry(
  path: string,
  lookup?: SpaceLookup,
  searchParams?:
    | URLSearchParams
    | Record<string, string | string[] | undefined>
    | Promise<Record<string, string | string[] | undefined>>,
): Promise<string | null> {
  const query = await stringifySearchParams(searchParams);
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const target = `${normalized}${query ? `?${query}` : ''}`;

  // Checked against the reachable set below: a space can be archived, or access
  // withdrawn, long after the cookie was written.
  const hinted = await getPreferredSpaceSlug();
  const reachable = lookup ? await reachableSlugs(lookup) : null;
  const slug = chooseSpaceSlug(hinted, reachable);

  return slug ? `/s/${encodeURIComponent(slug)}${target}` : null;
}

export async function enterPreferredSpace(
  path: string,
  lookup?: SpaceLookup,
  searchParams?:
    | URLSearchParams
    | Record<string, string | string[] | undefined>
    | Promise<Record<string, string | string[] | undefined>>,
) {
  const seen: { refusal?: SpaceLookupRefusal } = {};
  const observed: SpaceLookup | undefined = lookup && {
    ...lookup,
    report: (outcome) => {
      if (outcome.kind === 'refused') seen.refusal = outcome;
      lookup.report?.(outcome);
    },
  };
  const entry = await resolveSpaceEntry(path, observed, searchParams);
  if (seen.refusal !== undefined && lookup?.answerRefusal !== undefined) {
    const answer = await lookup.answerRefusal(seen.refusal);
    if (answer !== null) return answer;
  }
  if (entry !== null) {
    redirect(entry);
  }

  return <NoWorkspace />;
}

/** What a front door shows a visitor who reaches no space. */
function NoWorkspace() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>No workspace yet</h1>
        <p style={{ opacity: 0.75, lineHeight: 1.6 }}>
          Every surface lives inside a workspace, and this account can reach none. If the instance
          has just started, its first workspace may still be being created.
        </p>
      </div>
    </main>
  );
}

async function stringifySearchParams(
  input?:
    | URLSearchParams
    | Record<string, string | string[] | undefined>
    | Promise<Record<string, string | string[] | undefined>>,
): Promise<string> {
  if (!input) return '';
  const params = new URLSearchParams();
  const resolved = input instanceof URLSearchParams ? input : await input;
  if (resolved instanceof URLSearchParams) {
    return resolved.toString();
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string') params.append(key, v);
      }
    } else if (typeof value === 'string') {
      params.set(key, value);
    }
  }
  return params.toString();
}
