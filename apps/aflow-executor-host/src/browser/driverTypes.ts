/**
 * What the browser driver is asked and what it answers, apart from how it
 * does it: the step handler builds outputs from these and nothing else.
 */
import type { BrowserProfile } from '@aflow/schemas';

import type { ConsoleEntry, NetworkEntry } from './observations.js';
import type { BoundedSnapshot, Outline } from './outline.js';
import type { PageOwner } from './pageTable.js';
import type { EngineAction, EngineNavigation } from './types.js';

export interface RunScope extends PageOwner {
  readonly spaceId?: string;
}

export interface OpenRequest extends RunScope {
  readonly profileId: string;
  readonly url: string;
  /** An earlier delivery of this same step may already have opened it. */
  readonly redelivered: boolean;
}

export interface PageView {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly outline: Outline;
}

export interface OpenedPage extends PageView {
  readonly outcome: 'performed' | 'uncertain_outcome';
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
}

export interface ActRequest extends RunScope {
  readonly pageId: string;
  readonly ref: string;
  readonly action: EngineAction;
  readonly redelivered: boolean;
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
  readonly running: boolean;
  readonly sites?: string[];
  readonly sitesUnknown?: 'not_started' | 'stopped';
}

export interface IdleSweep {
  readonly closedPages: number;
  readonly stoppedProfiles: number;
}
