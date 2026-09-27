/**
 * Generic graph kit — React Flow + ELK primitives shared by every graph
 * surface in the console (agent editor, workflow inspector, process map).
 *
 * See ./GraphCanvas.tsx for usage.
 */
export { GraphCanvas, type GraphCanvasProps } from './GraphCanvas.js';
export {
  useGraphLayout,
  type UseGraphLayoutOptions,
  type UseGraphLayoutResult,
} from './useGraphLayout.js';
