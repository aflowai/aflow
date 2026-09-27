/**
 * Motion primitives for the Cybernetic Console (§8.4, §9, DL-15).
 *
 * All motion primitives:
 * - Respect prefers-reduced-motion (fall back to non-motion equivalents)
 * - Expose a `disabled` prop for testing
 * - Draw on shared canvas layers via MapCanvasLayer
 *
 * @packageDocumentation
 */
export { Pulse, type PulseProps } from './Pulse.js';
export { StuckAlert, type StuckAlertProps } from './StuckAlert.js';
export { Ripple, type RippleHandle, type RippleProps } from './Ripple.js';
export { FlowDot, type FlowDotHandle, type FlowDotProps } from './FlowDot.js';
