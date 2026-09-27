export { Row, type RowProps } from './Row.js';
export { Column, type ColumnProps } from './Column.js';
export { Grid, type GridProps } from './Grid.js';
export { Panel, type PanelProps, type PanelVariant } from './Panel.js';
export { Section, type SectionProps } from './Section.js';
export { CollapsibleSide, type CollapsibleSideProps } from './CollapsibleSide.js';
export { Spacer, type SpacerProps } from './Spacer.js';
export { ScrollArea, type ScrollAreaProps } from './ScrollArea.js';

// Re-export existing layout primitives
export { Box, type BoxProps } from '../primitives/Box.js';
export { Divider, type DividerProps } from '../primitives/Divider.js';
export {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  type CardProps,
  type CardHeaderProps,
  type CardBodyProps,
  type CardFooterProps,
} from '../primitives/Card.js';

// Backward-compat aliases
export { Row as Inline } from './Row.js';
export { Column as Stack } from './Column.js';
export type { RowProps as InlineProps } from './Row.js';
export type { ColumnProps as StackProps } from './Column.js';
