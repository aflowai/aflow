export { DiffView, type DiffViewProps } from './DiffView.js';
export {
  computeLineDiff,
  diffJson,
  diffStats,
  stableJson,
  type DiffLine,
  type DiffOp,
  type DiffStats,
} from './diff.js';
export { PropertyTable, type PropertyTableProps, type PropertyField } from './PropertyTable.js';
export { Accordion, type AccordionProps, type AccordionItemData } from './Accordion.js';
export { List, type ListProps, ListItem, type ListItemProps } from './List.js';
export {
  Table,
  type TableProps,
  Th,
  type ThProps,
  Td,
  type TdProps,
  Tr,
  type TrProps,
} from './Table.js';

// Re-export existing data-display components
export {
  KeyValueTable,
  type KeyValueTableProps,
  type KeyValuePair,
} from '../components/KeyValueTable.js';
export { CodeBlock, type CodeBlockProps } from '../components/CodeBlock.js';
export { JsonViewer, type JsonViewerProps } from '../components/JsonViewer.js';
export {
  Timeline,
  TimelineItem,
  type TimelineProps,
  type TimelineItemProps,
  type TimelineItemStatus,
} from '../components/Timeline.js';
export { ShimmerText, type ShimmerTextProps } from '../components/ShimmerText.js';
export { Swap, type SwapProps } from '../components/Swap.js';
export { SwapStack, type SwapStackProps } from '../components/SwapStack.js';
export { AnimatedHeight, type AnimatedHeightProps } from '../components/AnimatedHeight.js';
export { AnimatedWidth, type AnimatedWidthProps } from '../components/AnimatedWidth.js';
export { Stat, type StatProps, type StatTone } from './Stat.js';
export { ProgressRing, type ProgressRingProps } from './ProgressRing.js';
