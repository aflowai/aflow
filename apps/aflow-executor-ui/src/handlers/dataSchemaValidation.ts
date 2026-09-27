import * as Ajv from 'ajv';
import type { ErrorObject } from 'ajv';
import type { ValidationDiagnostic } from '@aflow/schemas';

const AjvCtor = (
  Ajv as unknown as {
    default: new (options: Record<string, unknown>) => {
      compile: (schema: Record<string, unknown>) => {
        (data: unknown): boolean;
        errors?: ErrorObject[] | null;
      };
    };
  }
).default;

const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  validateSchema: false,
  allowUnionTypes: true,
});

export interface DataSchemaValidationResult {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
}

function formatAjvErrorPath(error: ErrorObject): string {
  if (error.instancePath) {
    return error.instancePath;
  }

  const missingProperty =
    typeof error.params === 'object' &&
    error.params !== null &&
    'missingProperty' in error.params &&
    typeof error.params['missingProperty'] === 'string'
      ? error.params['missingProperty']
      : null;

  if (missingProperty) {
    return `/${missingProperty}`;
  }

  return '';
}

export function validateDataAgainstSchema(
  dataSchema: Record<string, unknown> | null | undefined,
  data: unknown,
): DataSchemaValidationResult {
  if (!dataSchema || Object.keys(dataSchema).length === 0) {
    return { valid: true, diagnostics: [] };
  }

  try {
    const validate = ajv.compile(dataSchema);
    const valid = validate(data);

    if (valid) {
      return { valid: true, diagnostics: [] };
    }

    const diagnostics: ValidationDiagnostic[] = (validate.errors ?? []).map(
      (error: ErrorObject) => {
        const path = formatAjvErrorPath(error);
        return {
          severity: 'error',
          code: 'data_schema_validation_failed',
          message: path ? `${path}: ${error.message ?? 'invalid'}` : (error.message ?? 'invalid'),
        };
      },
    );

    return { valid: false, diagnostics };
  } catch (error) {
    return {
      valid: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'data_schema_invalid',
          message:
            error instanceof Error
              ? `Data schema could not be compiled: ${error.message}`
              : 'Data schema could not be compiled',
        },
      ],
    };
  }
}
