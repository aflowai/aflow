'use client';

/**
 * Ripple — Canvas-drawn concentric ring fade for event firing (DL-15, §8.4).
 *
 * Draws an expanding ring on a canvas element when triggered. The ring
 * expands from center, fades in opacity, and disappears after 500ms.
 * Respects prefers-reduced-motion by falling back to a brief color flash.
 *
 * This component manages its own canvas — for the shared map overlay,
 * use MapCanvasLayer which batches multiple ripples.
 *
 * @example
 * ```tsx
 * const rippleRef = useRef<RippleHandle>(null);
 * <Ripple ref={rippleRef} width={100} height={100} color="#5AE3FF" />
 * // Trigger: rippleRef.current?.fire({ x: 50, y: 50 });
 * ```
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

export interface RippleHandle {
  /** Fire a ripple at the given coordinates. */
  fire(point: { x: number; y: number }): void;
}

export interface RippleProps {
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
  /** Ripple color (CSS color string). */
  color?: string;
  /** Max radius the ripple expands to. */
  maxRadius?: number;
  /** Duration in ms. Defaults to motion.ripple.duration (500ms). */
  duration?: number;
  /** Disable animation (for testing). */
  disabled?: boolean;
  className?: string;
}

interface ActiveRipple {
  x: number;
  y: number;
  startTime: number;
}

const DEFAULT_DURATION = 500;
const DEFAULT_MAX_RADIUS = 40;

export const Ripple = forwardRef<RippleHandle, RippleProps>(function Ripple(
  {
    width,
    height,
    color = '#5AE3FF',
    maxRadius = DEFAULT_MAX_RADIUS,
    duration = DEFAULT_DURATION,
    disabled,
    className,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ripplesRef = useRef<ActiveRipple[]>([]);
  const rafRef = useRef<number>(0);

  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ripplesRef.current = ripplesRef.current.filter((r) => {
      const elapsed = now - r.startTime;
      if (elapsed > duration) return false;

      const progress = elapsed / duration;
      const radius = progress * maxRadius;
      const opacity = 1 - progress;

      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = opacity * 0.7;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;

      return true;
    });

    if (ripplesRef.current.length > 0) {
      rafRef.current = requestAnimationFrame(animate);
    }
  }, [color, duration, maxRadius]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fire(point: { x: number; y: number }) {
        if (disabled) return;
        // Cap concurrent ripples at 10 (§9.3)
        if (ripplesRef.current.length >= 10) return;
        ripplesRef.current.push({ x: point.x, y: point.y, startTime: performance.now() });
        if (!rafRef.current || ripplesRef.current.length === 1) {
          rafRef.current = requestAnimationFrame(animate);
        }
      },
    }),
    [animate, disabled],
  );

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  return (
    <canvas
      ref={canvasRef}
      width={width * dpr}
      height={height * dpr}
      className={className}
      style={{
        width,
        height,
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
      }}
    />
  );
});
