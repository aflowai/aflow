'use client';

import { useEffect, type RefObject } from 'react';
import { peekPanelNextFocusOnTab } from '../cybernetic/peekPanelHelpers.js';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function collectFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('inert') && el.offsetParent !== null,
  );
}

export interface UseModalA11yOptions {
  /** Whether the modal is currently rendered. The hook is a no-op when false. */
  enabled: boolean;
  /** Ref to the modal root element. Used for focus trap + sibling-inert. */
  containerRef: RefObject<HTMLElement | null>;
}

export function useModalA11y({ enabled, containerRef }: UseModalA11yOptions): void {
  // --- Focus: capture previous + move into container; restore on close.
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = (document.activeElement as HTMLElement | null) ?? null;
    const focusables = collectFocusables(container);
    (focusables[0] ?? container).focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, [enabled, containerRef]);

  // --- Focus trap: keep Tab / Shift+Tab inside the container.
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = collectFocusables(root);
      const next = peekPanelNextFocusOnTab(
        focusables,
        document.activeElement as HTMLElement | null,
        e.shiftKey,
      );
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [enabled, containerRef]);

  // --- Background inert: mark each sibling of the container as inert
  //     while the modal is open. Restore the prior inert state on close.
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container?.parentElement) return;
    const siblings = Array.from(container.parentElement.children).filter(
      (el) => el !== container,
    ) as HTMLElement[];
    const previousInert: Array<[HTMLElement, boolean]> = [];
    for (const sib of siblings) {
      previousInert.push([sib, sib.hasAttribute('inert')]);
      sib.setAttribute('inert', '');
    }
    return () => {
      for (const [sib, hadInert] of previousInert) {
        if (!hadInert) sib.removeAttribute('inert');
      }
    };
  }, [enabled, containerRef]);
}
