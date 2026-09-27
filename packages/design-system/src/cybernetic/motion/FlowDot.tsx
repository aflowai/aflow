'use client';

/**
 * FlowDot — Canvas-drawn traveling dot on a Bezier curve (DL-9, DL-15).
 *
 * When triggered, a small dot travels along a pre-defined path from
 * source to destination over 700ms. Used for causal link animations
 * between Map nodes (delegation, memory read/write, results).
 *
 * @example
 * ```tsx
 * const flowRef = useRef<FlowDotHandle>(null);
 * <FlowDot ref={flowRef} width={800} height={600} />
 * // Trigger:
 * flowRef.current?.fire({
 *   from: { x: 100, y: 200 },
 *   to: { x: 500, y: 400 },
 *   color: '#48C9B0',
 * });
 * ```
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

export interface FlowDotHandle {
  /** Fire a flow-dot animation along a Bezier curve from source to destination. */
  fire(params: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    color?: string;
  }): void;
}

export interface FlowDotProps {
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
  /** Default dot color. */
  color?: string;
  /** Dot radius in pixels. */
  dotRadius?: number;
  /** Duration in ms. Defaults to motion.flow.duration (700ms). */
  duration?: number;
  /** Disable animation (for testing). */
  disabled?: boolean;
  className?: string;
}

interface ActiveFlow {
  from: { x: number; y: number };
  to: { x: number; y: number };
  cp1: { x: number; y: number };
  cp2: { x: number; y: number };
  color: string;
  startTime: number;
}

const DEFAULT_DURATION = 700;
const DEFAULT_DOT_RADIUS = 3;

/** Compute control points for a smooth Bezier between two points. */
function bezierControlPoints(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return {
    cp1: { x: from.x + dx * 0.3, y: from.y + dy * 0.05 },
    cp2: { x: from.x + dx * 0.7, y: to.y - dy * 0.05 },
  };
}

/** Evaluate cubic Bezier at parameter t. */
function bezierPoint(p0: number, p1: number, p2: number, p3: number, t: number) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

export const FlowDot = forwardRef<FlowDotHandle, FlowDotProps>(function FlowDot(
  {
    width,
    height,
    color = '#48C9B0',
    dotRadius = DEFAULT_DOT_RADIUS,
    duration = DEFAULT_DURATION,
    disabled,
    className,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flowsRef = useRef<ActiveFlow[]>([]);
  const rafRef = useRef<number>(0);

  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    flowsRef.current = flowsRef.current.filter((f) => {
      const elapsed = now - f.startTime;
      if (elapsed > duration) return false;

      const t = elapsed / duration;
      // Ease-in-out
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      const x = bezierPoint(f.from.x, f.cp1.x, f.cp2.x, f.to.x, eased);
      const y = bezierPoint(f.from.y, f.cp1.y, f.cp2.y, f.to.y, eased);

      // Draw a fading trail
      const trailLength = 5;
      for (let i = 0; i < trailLength; i++) {
        const trailT = Math.max(0, eased - i * 0.02);
        const tx = bezierPoint(f.from.x, f.cp1.x, f.cp2.x, f.to.x, trailT);
        const ty = bezierPoint(f.from.y, f.cp1.y, f.cp2.y, f.to.y, trailT);
        ctx.beginPath();
        ctx.arc(tx, ty, dotRadius * (1 - i * 0.15), 0, Math.PI * 2);
        ctx.fillStyle = f.color;
        ctx.globalAlpha = (1 - i / trailLength) * 0.6;
        ctx.fill();
      }

      // Draw the main dot
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = f.color;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;

      return true;
    });

    if (flowsRef.current.length > 0) {
      rafRef.current = requestAnimationFrame(animate);
    }
  }, [dotRadius, duration]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fire({ from, to, color: dotColor }) {
        if (disabled) return;
        // Cap concurrent flows at 10 (§9.3)
        if (flowsRef.current.length >= 10) return;
        const { cp1, cp2 } = bezierControlPoints(from, to);
        flowsRef.current.push({
          from,
          to,
          cp1,
          cp2,
          color: dotColor ?? color,
          startTime: performance.now(),
        });
        if (!rafRef.current || flowsRef.current.length === 1) {
          rafRef.current = requestAnimationFrame(animate);
        }
      },
    }),
    [animate, color, disabled],
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
