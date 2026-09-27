import type { SpaceToken } from '../tokens.js';

export interface SpacerProps {
  /** Fixed size — if omitted, Spacer fills remaining flex space */
  size?: SpaceToken;
}

export function Spacer({ size }: SpacerProps) {
  if (size != null) {
    return (
      <div
        style={{ flexShrink: 0, width: `var(--space-${size})`, height: `var(--space-${size})` }}
      />
    );
  }
  return <div style={{ flex: 1 }} />;
}
