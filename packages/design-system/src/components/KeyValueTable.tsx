import type { ReactNode } from 'react';

export interface KeyValuePair {
  key: string;
  value: ReactNode;
}

export interface KeyValueTableProps {
  /** Key-value pairs to display */
  items: KeyValuePair[];
  /** Key column width */
  keyWidth?: string;
  /** Additional class name */
  className?: string;
}

export function KeyValueTable({ items, keyWidth = '120px', className = '' }: KeyValueTableProps) {
  return (
    <div className={`ds-kv-table ${className}`}>
      {items.map(({ key, value }, index) => (
        <div key={key + String(index)} className="ds-kv-table__row">
          <div className="ds-kv-table__key" style={{ flex: `0 0 ${keyWidth}` }}>
            {key}
          </div>
          <div className="ds-kv-table__value">{value}</div>
        </div>
      ))}
    </div>
  );
}
