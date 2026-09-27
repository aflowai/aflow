// Motion primitives (§8.4, §9, DL-15)
export * from './motion/index.js';

// Map primitives
export { MapCanvasLayer, type MapCanvasLayerProps } from './MapCanvasLayer.js';
export { AnatomicalNode, type AnatomicalNodeProps } from './AnatomicalNode.js';
export { AnatomicalEdge, type AnatomicalEdgeProps } from './AnatomicalEdge.js';

// Hooks
export * from './hooks/index.js';

// Panels and overlays
export {
  PeekPanel,
  type PeekPanelProps,
  peekPanelShouldUseSheet,
  peekPanelNextFocusOnTab,
} from './PeekPanel.js';
export { CommandLauncher, type CommandLauncherProps } from './CommandLauncher.js';

// Controls
export { DensityToggle, type Density, type DensityToggleProps } from './DensityToggle.js';

// Typography
export { RegisterText, type RegisterTextProps, type TypographyRegister } from './RegisterText.js';

// Data display
export { EventCard, type EventCardProps } from './EventCard.js';

// Browser chassis (DL-22)
export {
  ArtifactBrowser,
  type ArtifactBrowserProps,
  type ArtifactBrowserAdapter,
  type ArtifactItem,
  type ArtifactTab,
  type ArtifactColumn,
} from './ArtifactBrowser.js';
