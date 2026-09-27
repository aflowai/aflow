/**
 * SurfaceMutationValidator — Validates surface mutations against the catalog.
 *
 * Ensures:
 * - Component types exist in the surface catalog
 * - Props conform to per-component schemas
 * - Bindings reference valid binding keys
 * - Actions are well-formed
 * - Message ordering makes sense (createSurface first, etc.)
 */
import type { SurfaceMutation, TypedSurfaceComponent } from '@aflow/schemas';
import { surfaceComponentPropSchemas } from '@aflow/schemas';

import type { SURFACE_CATALOG } from '@aflow/schemas';

// =============================================================================
// Types
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  code: string;
  message: string;
  componentId?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  componentId?: string;
}

// =============================================================================
// Validator
// =============================================================================

const VALID_COMPONENT_TYPES = new Set(Object.keys(surfaceComponentPropSchemas));

export class SurfaceMutationValidator {
  private surfaceCreated = false;
  private surfaceCompleted = false;

  constructor(private readonly catalog?: typeof SURFACE_CATALOG) {}

  /**
   * Validate a single surface mutation.
   * Returns validation result with errors and warnings.
   */
  validate(mutation: SurfaceMutation): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check ordering
    if (mutation.type === 'createSurface') {
      if (this.surfaceCreated) {
        warnings.push({
          code: 'DUPLICATE_CREATE',
          message: 'Surface already created — treating as reset.',
        });
      }
      this.surfaceCreated = true;
      this.surfaceCompleted = false;
    } else if (!this.surfaceCreated) {
      errors.push({
        code: 'NO_SURFACE',
        message: `Received ${mutation.type} before createSurface.`,
      });
    }

    if (this.surfaceCompleted && mutation.type !== 'deleteSurface') {
      warnings.push({
        code: 'POST_COMPLETE',
        message: `Mutation ${mutation.type} after completeSurface — may be ignored.`,
      });
    }

    if (mutation.type === 'completeSurface') {
      this.surfaceCompleted = true;
    }

    // Validate components
    if (
      (mutation.type === 'createSurface' || mutation.type === 'updateComponents') &&
      mutation.components
    ) {
      for (const comp of mutation.components) {
        this.validateComponent(comp, errors, warnings);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private validateComponent(
    comp: TypedSurfaceComponent,
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): void {
    // Check component type exists
    if (!VALID_COMPONENT_TYPES.has(comp.component)) {
      errors.push({
        code: 'UNKNOWN_COMPONENT',
        message: `Unknown component type: ${comp.component}`,
        componentId: comp.id,
      });
      return;
    }

    // Validate props against per-component schema
    if (comp.props) {
      const propSchema = surfaceComponentPropSchemas[comp.component];
      if (propSchema) {
        const result = propSchema.safeParse(comp.props);
        if (!result.success) {
          for (const issue of result.error.issues) {
            warnings.push({
              code: 'INVALID_PROP',
              message: `${comp.component}.${issue.path.join('.')}: ${issue.message}`,
              componentId: comp.id,
            });
          }
        }
      }
    }

    // Validate bindings reference valid binding keys for the component
    if (comp.bindings && this.catalog) {
      const catalogEntry = this.catalog.find((e) => e.component === comp.component);
      if (catalogEntry?.bindingKeys) {
        for (const key of Object.keys(comp.bindings)) {
          if (!catalogEntry.bindingKeys.includes(key)) {
            warnings.push({
              code: 'UNKNOWN_BINDING',
              message: `${comp.component} does not document binding key "${key}". Known keys: ${catalogEntry.bindingKeys.join(', ')}`,
              componentId: comp.id,
            });
          }
        }
      }
    }

    // Validate actions
    if (comp.actions) {
      for (const action of comp.actions) {
        if (!action.eventName) {
          errors.push({
            code: 'MISSING_EVENT_NAME',
            message: 'Action missing eventName',
            componentId: comp.id,
          });
        }
      }
    }
  }

  /** Reset validator state (for reuse). */
  reset(): void {
    this.surfaceCreated = false;
    this.surfaceCompleted = false;
  }
}
