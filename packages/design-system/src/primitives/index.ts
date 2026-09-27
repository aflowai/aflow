/**
 * Primitive Components
 *
 * Low-level building blocks for the design system.
 */

// Layout
export { Box, type BoxProps } from './Box.js';
export { Stack, Inline, type StackProps, type InlineProps } from './Stack.js';

// Typography
export { Text, Heading, type TextProps, type TextVariant, type HeadingProps } from './Text.js';

// Icons
export { Icon, type IconProps, type IconWeight, type PhosphorIconProps } from './Icon.js';

// Actions
export {
  Button,
  IconButton,
  type ButtonProps,
  type IconButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './Button.js';

// Forms
export {
  Input,
  Textarea,
  Select,
  Label,
  HelperText,
  FieldError,
  Field,
  type InputProps,
  type TextareaProps,
  type SelectProps,
  type LabelProps,
  type HelperTextProps,
  type FieldErrorProps,
  type FieldProps,
} from './Input.js';
export { Checkbox, type CheckboxProps, type CheckboxSize } from './Checkbox.js';
export { Avatar, type AvatarProps, type AvatarSize } from './Avatar.js';

// Feedback
export { Badge, type BadgeProps, type BadgeVariant } from './Badge.js';
export { Spinner, type SpinnerProps, type SpinnerSize } from './Spinner.js';
export { Tooltip, type TooltipProps } from './Tooltip.js';

// Layout elements
export {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  type CardProps,
  type CardHeaderProps,
  type CardBodyProps,
  type CardFooterProps,
} from './Card.js';
export { Divider, type DividerProps } from './Divider.js';

// Tabs
export {
  Tabs,
  TabList,
  Tab,
  TabPanel,
  type TabsProps,
  type TabListProps,
  type TabProps,
  type TabPanelProps,
} from './Tabs.js';

// Overlays
export { Dialog, type DialogProps } from './Dialog.js';
