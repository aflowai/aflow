/**
 * What the driver needs from a browser automation library, and nothing more.
 *
 * One module implements it against `playwright-core`; tests implement it with
 * a fake. Keeping the surface this small is what lets the driver's rules —
 * ownership, origins, the outline bound — be tested without a browser.
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

export interface EnginePage {
  goto(url: string, timeoutMs: number): Promise<void>;
  url(): string;
  title(): Promise<string>;
  snapshot(): Promise<PageSnapshot>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface EngineBrowser {
  newPage(): Promise<EnginePage>;
  /** Drop the connection. The browser process is the launcher's to end. */
  disconnect(): Promise<void>;
}

export interface BrowserEngine {
  /** Attach to a running browser at its DevTools websocket endpoint. */
  connect(endpoint: string, timeoutMs: number): Promise<EngineBrowser>;
}
