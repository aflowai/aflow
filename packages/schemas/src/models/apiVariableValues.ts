import { z } from 'zod';

/**
 * Binding-time variable VALUES. Keys reference `baseUrlTemplate` placeholders so
 * they must be identifiers; values are host-safe (letters, digits, dot,
 * underscore, hyphen — never URL delimiters like `/`, `@`, `:`) so a value can't
 * escape the template's host. Empty values are allowed (a partial save before
 * all are filled). NON-SECRET — secrets stay in credentials.
 *
 * Leaf module (zod only): imported by both `apiDefinition.ts` and the
 * `operations/platform.ts` upsert op without creating an import cycle through
 * `operations/api.ts` → `operations/platform.ts`.
 */
export const ApiVariableValuesSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9._-]*$/, {
      message:
        'Variable values are host-safe (letters, digits, dot, underscore, hyphen) — no URL delimiters like /, @, :.',
    }),
);
export type ApiVariableValues = z.infer<typeof ApiVariableValuesSchema>;
