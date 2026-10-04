/**
 * What the browser driver is asked and what it answers, apart from how it
 * does it: the step handler builds outputs from these and nothing else.
 */
import type {
  BrowserHandoffOutcome,
  BrowserHandoffReason,
  BrowserProfile,
  RunTrigger,
} from '@aflow/schemas';

import type { ConsoleEntry, NetworkEntry } from './observations.js';
import type { BoundedSnapshot, Outline } from './outline.js';
import type { PageOwner } from './pageTable.js';
import type { TakenScreenshot } from './screenshot.js';
import type { EngineAction, EngineNavigation } from './types.js';

export interface RunScope extends PageOwner {
  readonly spaceId?: string;
  /** What started the root of the run, as its job carries it; absent reads as nobody. */
  readonly rootTrigger?: RunTrigger;
}

export interface OpenRequest extends RunScope {
  readonly profileId: string;
  readonly url: string;
  /** An earlier delivery of this same step may already have opened it. */
  readonly redelivered: boolean;
  readonly maxChars?: number;
}

export interface PageView {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly outline: Outline;
  /** Two reads a moment apart agreed before this one was returned. */
  readonly settled: boolean;
}

export interface OpenedPage extends PageView {
  readonly outcome: 'performed' | 'uncertain_outcome';
  /** The page is not at the address asked for, compared whole rather than as `url` shows it. */
  readonly redirected: boolean;
}

export interface ChangeReceipt {
  readonly urlChanged: boolean;
  readonly titleChanged: boolean;
  readonly outlineChanged: boolean;
}

export type NavigationResult =
  | { readonly outcome: 'performed'; readonly view: PageView; readonly changed: ChangeReceipt }
  | { readonly outcome: 'uncertain_outcome'; readonly view: PageView };

export type ActionResult =
  | {
      readonly outcome: 'performed';
      readonly view: PageView;
      readonly changed: ChangeReceipt;
      readonly element: { readonly role: string; readonly name?: string };
      readonly typed?: {
        readonly field: string;
        readonly characters: number;
        readonly submitted: boolean;
      };
    }
  | { readonly outcome: 'uncertain_outcome'; readonly view: PageView };

export interface NavigateRequest extends RunScope {
  readonly pageId: string;
  readonly to: EngineNavigation;
  /** An earlier delivery of this same step may already have done it. */
  readonly redelivered: boolean;
  readonly maxChars?: number;
}

export interface ActRequest extends RunScope {
  readonly pageId: string;
  readonly ref: string;
  readonly action: EngineAction;
  readonly redelivered: boolean;
  readonly maxChars?: number;
}

export interface SnapshotResult {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly snapshot: BoundedSnapshot;
}

export type ReadResult =
  | {
      readonly what: 'text';
      readonly url: string;
      readonly text: string;
      readonly withheld: number;
      readonly nextOffset?: number;
    }
  | {
      readonly what: 'console';
      readonly url: string;
      readonly console: ConsoleEntry[];
      readonly withheld: number;
      readonly notRetained: number;
    }
  | {
      readonly what: 'network';
      readonly url: string;
      readonly network: NetworkEntry[];
      readonly withheld: number;
      readonly notRetained: number;
    };

export interface ListedPage {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly profileId: string;
  readonly lastUsedAt: number;
}

export interface ListedProfile {
  readonly profileId: string;
  readonly posture: BrowserProfile['posture'];
  readonly window: BrowserProfile['window'];
  readonly unattended: boolean;
  /** False when nobody started the run asking and the profile takes no such run. */
  readonly openToThisRun: boolean;
  readonly running: boolean;
  readonly sites?: string[];
  readonly sitesUnknown?: 'not_started' | 'stopped';
}

export interface ReadRequest {
  readonly what: ReadResult['what'];
  readonly contains?: string;
  readonly offset?: number;
  readonly maxChars?: number;
}

/** A profile as the machine sees it, whichever spaces it serves. */
export interface MachineProfile {
  readonly profile: BrowserProfile;
  readonly running: boolean;
  /** Whether the operator has its window now. */
  readonly windowShown: boolean;
  /** The hosts it holds cookies for, while it runs. */
  readonly sites?: string[];
}

export interface ScreenshotResult extends TakenScreenshot {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
}

export interface EvaluateResult {
  readonly pageId: string;
  readonly url: string;
  /** The script's value as JSON, `undefined` when it had none. */
  readonly value: string;
  /** The JSON was longer than a read returns, and `value` is its start. */
  readonly cut: boolean;
}

export interface HandoffRequest extends RunScope {
  /** The step that waits: the Action Center's Done is addressed to it. */
  readonly stepExecutionId: string;
  readonly sessionId?: string;
  readonly pageId: string;
  readonly reason: BrowserHandoffReason;
  /** For the operator: what is needed, and what the run does next. */
  readonly message: string;
  readonly maxChars?: number;
}

export interface HandoffResult {
  readonly outcome: BrowserHandoffOutcome;
  readonly view: PageView;
  /** The page this hand-off was given, when a new page replaced it. */
  readonly previousPageId?: string;
  readonly restarted: boolean;
  readonly waitedMs: number;
}

export interface SignInOptions {
  /** The longest the window stays open; the sitting's own limit when absent. */
  readonly maxMs?: number;
  /** Told once the window is on the operator's screen. */
  readonly onShown?: () => void;
}

export interface SignInResult {
  readonly outcome: 'window_closed' | 'timed_out';
  readonly restarted: boolean;
  /** The hosts the profile holds cookies for once the operator was done. */
  readonly sites: string[];
}

export interface IdleSweep {
  readonly closedPages: number;
  readonly stoppedProfiles: number;
}
