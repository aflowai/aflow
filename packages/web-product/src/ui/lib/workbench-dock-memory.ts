/**
 * Whether the chat's Workbench dock is open when the operator lands on a
 * conversation (Plan 338 D3).
 *
 * A new chat opens it, so the operator lands on what waits on them without
 * opening anything. A conversation the operator collapsed it in stays
 * collapsed: this browser remembers the ids of those conversations, and only
 * those. A phone keeps the chat first, because there the Workbench is a mode
 * that replaces the chat, not a pane beside it.
 */
export function workbenchOpenOnLanding(input: {
  conversationId: string | null;
  collapsed: readonly string[];
  phone: boolean;
  /** The arrival URL asked for the Workbench (`?workbench=1`, the bell). */
  askedOpen: boolean;
}): boolean {
  if (input.askedOpen) return true;
  if (input.phone) return false;
  if (input.conversationId === null) return true;
  return !input.collapsed.includes(input.conversationId);
}

/**
 * How many collapsed conversations a browser remembers. The oldest choice is
 * dropped first, and a conversation it drops lands open again.
 */
export const WORKBENCH_COLLAPSED_LIMIT = 200;

export const WORKBENCH_COLLAPSED_STORAGE_KEY = 'aflow.chat.workbenchCollapsed';

/** The remembered list after the operator leaves the dock open or closed in a conversation. */
export function rememberWorkbenchState(
  collapsed: readonly string[],
  conversationId: string,
  open: boolean,
): string[] {
  const rest = collapsed.filter((id) => id !== conversationId);
  return open ? rest : [conversationId, ...rest].slice(0, WORKBENCH_COLLAPSED_LIMIT);
}

/** Storage that is missing, full or refusing reads as an empty memory. */
export function readCollapsedConversations(storage: Pick<Storage, 'getItem'> | null): string[] {
  try {
    const raw = storage?.getItem(WORKBENCH_COLLAPSED_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeCollapsedConversations(
  storage: Pick<Storage, 'setItem'> | null,
  collapsed: readonly string[],
): void {
  try {
    storage?.setItem(WORKBENCH_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed));
  } catch {
    // A refused write costs only the memory: the next landing opens the dock.
  }
}

/** This browser's storage, where there is one. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
