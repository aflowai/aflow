/**
 * What the sidebar rail is doing, as geometry.
 *
 * Two states, and they are not the same state. Hovering the collapsed rail
 * slides it over the content: names appear without a click and nothing else
 * moves, because the space the rail takes from the content is unchanged.
 * Clicking pins it, and a pinned rail pushes the content as it always has —
 * an operator who asked for the names does not want the page to jump every
 * time the pointer crosses the edge.
 *
 * Pure so the machine is testable: the shell itself pulls the whole app tree
 * in behind it and the web test environment carries no renderer.
 */

/**
 * Long enough that a pointer crossing the rail on its way somewhere else does
 * not open it, short enough that a pointer arriving to read a name does not
 * wait. Closing is immediate: a rail that lingers over the content is in the
 * way.
 */
export const RAIL_HOVER_EXPAND_DELAY_MS = 180;

export interface RailLayoutInput {
  /** The operator clicked the control: names stay until they say otherwise. */
  pinnedOpen: boolean;
  /** The pointer has rested on the rail for the delay above. */
  hovering: boolean;
  /**
   * Whether a pointer on this device hovers at all. A tap fires the same enter
   * event, and a rail that opened on tap would swallow the tap that was aimed
   * at a link — so touch keeps the click path and this is how it is told apart.
   */
  hoverCapable: boolean;
  /** Below the desktop breakpoint the drawer replaces the rail entirely. */
  isMobile: boolean;
  /** The rail's width with names hidden. */
  railWidth: number;
  /** The rail's width with names shown. */
  expandedWidth: number;
}

export interface RailLayout {
  /** Names are shown. */
  expanded: boolean;
  /** Painted above the content rather than beside it, so nothing reflows. */
  overlay: boolean;
  /** The width the rail takes from the content. */
  occupiedWidth: number;
  /** The width the rail paints itself at. */
  renderedWidth: number;
}

export function railLayout(input: RailLayoutInput): RailLayout {
  const hoverExpanded =
    input.hovering && input.hoverCapable && !input.isMobile && !input.pinnedOpen;
  const expanded = input.pinnedOpen || hoverExpanded;
  return {
    expanded,
    overlay: hoverExpanded,
    // Pinned is the only state that moves the content: a hover-expanded rail
    // keeps the collapsed rail's footprint and paints over what is beside it.
    occupiedWidth: input.pinnedOpen ? input.expandedWidth : input.railWidth,
    renderedWidth: expanded ? input.expandedWidth : input.railWidth,
  };
}
