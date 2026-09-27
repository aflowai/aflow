export interface PropertyField {
  /** Field name */
  name: string;
  /** Field type label */
  type?: string;
  /** Whether field is required */
  required?: boolean;
  /** Description */
  description?: string;
  /** Nested fields (for object/array types) */
  children?: PropertyField[];
}

export interface PropertyTableProps {
  /** Fields to display */
  fields: PropertyField[];
  /** Indent level (used internally for nesting) */
  level?: number;
  /** Expanded field names */
  expandedFields?: Set<string> | undefined;
  /** Toggle field expansion */
  onToggleField?: ((fieldName: string) => void) | undefined;
}

export function PropertyTable({
  fields,
  level = 0,
  expandedFields,
  onToggleField,
}: PropertyTableProps) {
  if (fields.length === 0) return null;

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 'var(--font-size-sm)',
      }}
    >
      {level === 0 && (
        <thead>
          <tr>
            <th
              style={{
                textAlign: 'left',
                padding: 'var(--space-sm) var(--space-md)',
                fontSize: 'var(--font-size-xs)',
                fontWeight: 'var(--font-weight-medium)',
                color: 'var(--color-content-muted)',
                borderBottom: '1px solid var(--color-border-default)',
                letterSpacing: 'var(--font-letter-spacing-wide)',
                textTransform: 'uppercase',
              }}
            >
              Field
            </th>
            <th
              style={{
                textAlign: 'left',
                padding: 'var(--space-sm) var(--space-md)',
                fontSize: 'var(--font-size-xs)',
                fontWeight: 'var(--font-weight-medium)',
                color: 'var(--color-content-muted)',
                borderBottom: '1px solid var(--color-border-default)',
                letterSpacing: 'var(--font-letter-spacing-wide)',
                textTransform: 'uppercase',
              }}
            >
              Type
            </th>
            <th
              style={{
                textAlign: 'left',
                padding: 'var(--space-sm) var(--space-md)',
                fontSize: 'var(--font-size-xs)',
                fontWeight: 'var(--font-weight-medium)',
                color: 'var(--color-content-muted)',
                borderBottom: '1px solid var(--color-border-default)',
                letterSpacing: 'var(--font-letter-spacing-wide)',
                textTransform: 'uppercase',
              }}
            >
              Description
            </th>
          </tr>
        </thead>
      )}
      <tbody>
        {fields.map((field) => {
          const hasChildren = field.children != null && field.children.length > 0;
          const _fieldPath = `${'  '.repeat(level)}${field.name}`;
          const isExpanded = expandedFields?.has(field.name) ?? false;

          return (
            <PropertyTableRow
              key={field.name}
              field={field}
              level={level}
              hasChildren={hasChildren}
              isExpanded={isExpanded}
              onToggle={onToggleField}
              expandedFields={expandedFields}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function PropertyTableRow({
  field,
  level,
  hasChildren,
  isExpanded,
  onToggle,
  expandedFields,
}: {
  field: PropertyField;
  level: number;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggle?: ((name: string) => void) | undefined;
  expandedFields?: Set<string> | undefined;
}) {
  return (
    <>
      <tr
        style={{
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        <td
          style={{
            padding: 'var(--space-sm) var(--space-md)',
            paddingLeft: `calc(var(--space-md) + ${level * 20}px)`,
            fontFamily: 'var(--font-family-mono)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-content-primary)',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
            {hasChildren && (
              <button
                type="button"
                onClick={() => onToggle?.(field.name)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--color-content-muted)',
                  padding: 0,
                  transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition:
                    'transform var(--transition-duration-fast) var(--transition-timing-default)',
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
              </button>
            )}
            {field.name}
            {field.required && (
              <span
                style={{ color: 'var(--color-danger-default)', fontSize: 'var(--font-size-xs)' }}
              >
                *
              </span>
            )}
          </span>
        </td>
        <td
          style={{
            padding: 'var(--space-sm) var(--space-md)',
            fontFamily: 'var(--font-family-mono)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-content-muted)',
          }}
        >
          {field.type}
        </td>
        <td
          style={{
            padding: 'var(--space-sm) var(--space-md)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-content-secondary)',
          }}
        >
          {field.description}
        </td>
      </tr>
      {hasChildren && isExpanded && field.children != null && (
        <tr>
          <td colSpan={3} style={{ padding: 0 }}>
            <PropertyTable
              fields={field.children}
              level={level + 1}
              expandedFields={expandedFields}
              onToggleField={onToggle}
            />
          </td>
        </tr>
      )}
    </>
  );
}
