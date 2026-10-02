/**
 * What the driver needs from a browser automation library, and nothing more.
 *
 * One module implements it against `playwright-core`; tests implement it with
 * a fake. Keeping the surface this small is what lets the driver's rules —
 * ownership, posture, origins, the outline bound, never replaying an action —
 * be tested without a browser.
 */

export interface PageSnapshot {
  /** The accessibility snapshot, one element per line, each with its `[ref=…]`. */
  readonly text: string;
  /**
   * References whose value must never leave the machine: password fields, and
   * any text field the engine could not confirm is not one.
   */
  readonly maskedRefs: ReadonlySet<string>;
}

export type EngineNavigation =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  | { readonly kind: 'reload' };

export type EngineAction =
  | { readonly kind: 'click' }
  | { readonly kind: 'hover' }
  | { readonly kind: 'type'; readonly text: string; readonly submit: boolean }
  | { readonly kind: 'select'; readonly values: readonly string[] }
  | { readonly kind: 'press'; readonly key: string };

/** The reference resolves to no element on the page as it is now. */
export class EngineRefNotFound extends Error {
  constructor(readonly ref: string) {
    super(`No element on the page answers to reference ${ref}.`);
    this.name = 'EngineRefNotFound';
  }
}

/** The element is one a credential is typed into. */
export class EngineCredentialField extends Error {
  constructor(readonly ref: string) {
    super(`Element ${ref} is a password field.`);
    this.name = 'EngineCredentialField';
  }
}

/**
 * A navigation that did not complete. `redirectChain` is the addresses the
 * page's main frame requested for it, the first request and then each
 * redirect from it, in order — the only hosts a refusal may be blamed on.
 */
export class EngineNavigationFailed extends Error {
  constructor(
    message: string,
    readonly redirectChain: readonly string[],
  ) {
    super(message);
    this.name = 'EngineNavigationFailed';
  }
}

export interface PageRequest {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly failure?: string;
  readonly resourceType: string;
}

/** What a page reports from the moment it is created. */
export interface PageEvents {
  console(level: string, text: string): void;
  request(request: PageRequest): void;
}

export interface EnginePage {
  /**
   * Moves the page and settles once its document has loaded, waiting a short
   * while longer for the load event and going on without it. False when there
   * was no history entry to go back or forward to. Fails with
   * `EngineNavigationFailed`.
   */
  navigate(to: EngineNavigation): Promise<boolean>;
  /** Throws `EngineRefNotFound` or `EngineCredentialField` before doing anything. */
  act(ref: string, action: EngineAction): Promise<void>;
  /**
   * The address of the frame the referenced element belongs to — the page's
   * own for an element in the top document. A frame with no address of its
   * own (`about:blank`, `srcdoc`) answers with the nearest frame above it
   * that has one. Throws `EngineRefNotFound` when nothing answers to it.
   */
  frameUrl(ref: string): Promise<string>;
  url(): string;
  title(): Promise<string>;
  snapshot(): Promise<PageSnapshot>;
  /** The page's visible text. */
  text(): Promise<string>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface EngineBrowser {
  newPage(events: PageEvents): Promise<EnginePage>;
  /** The hosts the profile holds cookies for, by name. Never a value. */
  cookieSites(): Promise<string[]>;
  /** Drop the connection. The browser process is the launcher's to end. */
  disconnect(): Promise<void>;
}

export interface BrowserEngine {
  /** Attach to a running browser at its DevTools websocket endpoint. */
  connect(endpoint: string, timeoutMs: number): Promise<EngineBrowser>;
}
