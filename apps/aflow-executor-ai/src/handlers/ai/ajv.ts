/**
 * AJV instance for JSON Schema validation.
 */
import AjvModule from 'ajv';

export interface AjvValidateFunction {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
}

export interface AjvInstance {
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}

// Handle CJS/ESM interop
type AjvConstructor = new (opts: { allErrors?: boolean; strict?: boolean }) => AjvInstance;
const mod = AjvModule as unknown as { default?: AjvConstructor };
const Ajv: AjvConstructor = mod.default ?? (AjvModule as unknown as AjvConstructor);
export const ajv: AjvInstance = new Ajv({ allErrors: true, strict: false });
