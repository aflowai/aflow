'use client';

import { useCallback, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Popup-based OAuth consent launcher (Plan 185)
// ---------------------------------------------------------------------------
//
// "Connect" must not navigate the app tab away — the user would land on the API
// server's success page and be stranded. Instead we run consent in a popup so
// the app tab stays put and refreshes itself when the popup closes.
//
// The load-bearing browser constraint: `window.open` is blocked unless it runs
// synchronously inside the click-gesture call stack. After an `await` the
// gesture is gone and the popup is a popup-blocker hit. So callers open a blank
// popup synchronously on click, then this helper navigates that SAME window
// once the consent-start mutation resolves — it never opens a second window.

const POPUP_NAME = 'phoenix-oauth-consent';
const POPUP_FEATURES = 'popup,width=620,height=760';
const CLOSE_POLL_INTERVAL_MS = 600;

export interface OAuthConsentLaunchArgs {
  /**
   * Resolves the authorization URL via the consent-start mutation. Called only
   * when `directUrl` is absent. A resolved value with no `authorizationUrl`
   * surfaces as a launch error (popup closed).
   */
  start?: () => Promise<{ authorizationUrl?: string } | undefined>;
  /**
   * A fully-resolved authorization URL known synchronously at click time (the
   * executor's `authorizationUrlHint`). When present, `start` is not called.
   */
  directUrl?: string;
  /** Run after the popup closes — invalidate queries so the UI reflects the new connection. */
  onClosed: () => void;
  /** Surface a launch failure inline. Called with a human-readable message. */
  onError?: (message: string) => void;
}

export interface OAuthConsentPopupController {
  launch: (args: OAuthConsentLaunchArgs) => void;
}

/**
 * Drive popup-based OAuth consent from a click handler.
 *
 * Usage from a click handler:
 *   const { launch } = useOAuthConsentPopup();
 *   onClick={() => launch({ start: () => mutateAsync(undefined), onClosed })}
 *
 * `launch` opens the popup synchronously (so it survives the popup blocker),
 * then awaits `start()` / uses `directUrl` and navigates the existing popup.
 * If the browser blocked the popup, it falls back to a same-tab redirect once
 * the URL is known. A close-poller invokes `onClosed` when the user finishes.
 */
export function useOAuthConsentPopup(): OAuthConsentPopupController {
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Clear any in-flight close-poller on unmount so a closed popup can't fire
  // `onClosed` into an unmounted component, and the interval doesn't leak.
  useEffect(() => clearPoll, [clearPoll]);

  const watchForClose = useCallback(
    (popup: Window, onClosed: () => void) => {
      clearPoll();
      pollRef.current = setInterval(() => {
        if (popup.closed) {
          clearPoll();
          onClosed();
        }
      }, CLOSE_POLL_INTERVAL_MS);
    },
    [clearPoll],
  );

  const launch = useCallback(
    (args: OAuthConsentLaunchArgs): void => {
      const { start, directUrl, onClosed, onError } = args;

      // Synchronous open — must be in the direct click-gesture call stack.
      // `null` means the popup blocker fired; we fall back to a same-tab redirect.
      const popup = window.open('about:blank', POPUP_NAME, POPUP_FEATURES);

      const navigate = (authorizationUrl: string): void => {
        if (popup) {
          popup.location.href = authorizationUrl;
          watchForClose(popup, onClosed);
        } else {
          // Popup blocked — preserve the legacy same-tab behaviour.
          window.location.assign(authorizationUrl);
        }
      };

      const fail = (message: string): void => {
        if (popup) popup.close();
        onError?.(message);
      };

      if (directUrl) {
        navigate(directUrl);
        return;
      }

      if (!start) {
        fail('No authorization URL available.');
        return;
      }

      void start()
        .then((result) => {
          const url = result?.authorizationUrl;
          if (url) {
            navigate(url);
          } else {
            fail('Consent endpoint returned no authorization URL.');
          }
        })
        .catch((err: unknown) => {
          fail(err instanceof Error ? err.message : String(err));
        });
    },
    [watchForClose],
  );

  return { launch };
}
