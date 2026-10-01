'use client';

import { useEffect, useId, useState, type CSSProperties } from 'react';
import { useTheme } from '../../providers/theme.js';
import type { OrbKind } from './workflowRunSurfaceHelpers.js';

const ORB_SRC: Record<OrbKind, { dark: string; light: string }> = {
  running: { dark: '/orb-running.svg', light: '/orb-running-light.svg' },
  paused: { dark: '/orb-paused.svg', light: '/orb-paused-light.svg' },
  completed: { dark: '/orb-completed.svg', light: '/orb-completed-light.svg' },
  failed: { dark: '/orb-failed.svg', light: '/orb-failed-light.svg' },
  inert: { dark: '/orb-inert.svg', light: '/orb-inert-light.svg' },
  idle: { dark: '/orb-idle.svg', light: '/orb-idle-light.svg' },
  searching: { dark: '/orb-searching.svg', light: '/orb-searching-light.svg' },
  handed_off: { dark: '/orb-handed-off.svg', light: '/orb-handed-off-light.svg' },
};

const ORB_LABEL: Record<OrbKind, string> = {
  running: 'Running',
  paused: 'Paused — action expected',
  completed: 'Completed',
  failed: 'Failed',
  inert: 'Inactive',
  idle: 'Idle',
  searching: 'Searching',
  handed_off: 'Handed off — reports to another session',
};

/** Shared fetch cache so N orbs of the same kind hit the network once. */
const svgTextCache = new Map<string, Promise<string>>();

function loadSvgText(url: string): Promise<string> {
  let pending = svgTextCache.get(url);
  if (!pending) {
    pending = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to load orb SVG: ${url}`);
      return res.text();
    });
    svgTextCache.set(url, pending);
  }
  return pending;
}

/** Stable 0–40s phase from React's per-instance id (SSR-safe, unique per mount). */
function phaseSecFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 4000) / 100;
}

/**
 * Seek each SMIL animation into a negative begin so instances that mount
 * together aren't phase-locked. Still loaded as `<img>` (blob URL) so
 * gradient/filter ids stay isolated per document.
 */
function injectAnimationPhase(svgText: string, phaseSec: number): string {
  if (!/<(?:animateTransform|animate|animateMotion)\b/.test(svgText)) {
    return svgText;
  }
  const beginAttr = `begin="-${phaseSec.toFixed(2)}s"`;
  return svgText.replace(
    /<(animateTransform|animate|animateMotion)(\s[^>]*?)?\s*(\/?)\s*>/g,
    (_full, tag: string, rawAttrs: string | undefined, close: string) => {
      const attrs = rawAttrs ?? '';
      if (/\bbegin\s*=/.test(attrs)) {
        return `<${tag}${attrs.replace(/\bbegin\s*=\s*(["'])[\s\S]*?\1/, ` ${beginAttr}`)}${close ? ' /' : ''}>`;
      }
      return `<${tag}${attrs} ${beginAttr}${close ? ' /' : ''}>`;
    },
  );
}

export interface StatusOrbProps {
  kind: OrbKind;
  /** Pixel size — header ~84, timeline marker ~48. */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Override the default aria-label derived from `kind`. */
  label?: string;
  /** Decorative (default): hide from AT when a nearby text status exists. */
  decorative?: boolean;
}

/**
 * Abstract status orb — motion/color semantics without anthropomorphism.
 * Loaded as `<img>` so each instance is an isolated SVG document (no
 * colliding gradient/filter ids when many orbs share a page). Dark and
 * light assets are paired; `useTheme().resolvedTheme` picks the file.
 * Animation phase is per-instance so a row of orbs doesn't march in lockstep.
 */
export function StatusOrb({
  kind,
  size = 28,
  className,
  style,
  label,
  decorative = true,
}: StatusOrbProps) {
  const { resolvedTheme } = useTheme();
  const fileSrc = ORB_SRC[kind][resolvedTheme];
  const reactId = useId();
  const [src, setSrc] = useState(fileSrc);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setSrc(fileSrc);

    void loadSvgText(fileSrc)
      .then((text) => {
        if (cancelled) return;
        const phased = injectAnimationPhase(text, phaseSecFromId(reactId));
        if (phased === text) {
          // No SMIL to offset (e.g. inert) — keep the static asset URL.
          return;
        }
        const blob = new Blob([phased], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        revoked = url;
        setSrc(url);
      })
      .catch(() => {
        // Keep fileSrc fallback if fetch fails.
      });

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [fileSrc, reactId]);

  const alt = label ?? ORB_LABEL[kind];
  return (
    <img
      src={src}
      alt={decorative ? '' : alt}
      width={size}
      height={size}
      className={['workflow-run-surface__orb', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, ...style }}
      draggable={false}
      {...(decorative
        ? { 'aria-hidden': true as const }
        : { role: 'img' as const, 'aria-label': alt })}
    />
  );
}
