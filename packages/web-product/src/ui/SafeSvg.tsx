'use client';

/**
 * The only supported way to put untrusted SVG into the DOM.
 *
 * Two things make it safe, and both are needed:
 *
 * 1. `sanitizeSvg` removes execution and network vectors. It runs in an effect
 *    rather than during render because the sanitizer needs a real DOM — on the
 *    server it cannot inspect the markup at all, so sanitizing during render
 *    would ship the unsanitized source in the SSR payload.
 * 2. A shadow root contains the styling. Illustrations legitimately carry
 *    `<style>` blocks (theming custom properties, `@keyframes`), and CSS in an
 *    inline SVG is document-scoped — an illustration could otherwise restyle
 *    the application around it. Custom properties still inherit inward, so
 *    theming keeps working.
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import { sanitizeSvg } from './sanitizeSvg.js';

/** Lets the illustration scale to the host box the caller sized. */
const SHADOW_BASE_STYLE = ':host{display:contents}svg{max-width:100%;max-height:100%}';

export interface SafeSvgProps {
  source: string;
  style?: CSSProperties;
  className?: string;
}

export function SafeSvg({ source, style, className }: SafeSvgProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const markup = sanitizeSvg(source);
    root.innerHTML = markup ? `<style>${SHADOW_BASE_STYLE}</style>${markup}` : '';

    return () => {
      root.innerHTML = '';
    };
  }, [source]);

  return <div ref={hostRef} className={className} style={style} />;
}
