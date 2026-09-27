import type { StateVariable, StepDefinition } from '../../../lib/flow-to-graph.js';
import type { CatalogOperation } from '../../../hooks/use-operation-catalog.js';

export interface BindingsEditorProps {
  step: StepDefinition;
  variables: StateVariable[];
  operationInputSchema?: Record<string, unknown> | undefined;
  operationOutputSchema?: Record<string, unknown> | undefined;
  /** Fields managed internally by the orchestrator — hidden from the UI */
  internalFields?:
    | {
        input?: string[] | undefined;
        output?: string[] | undefined;
      }
    | undefined;
  onUpdateStep: (patch: Partial<StepDefinition>) => void;
  /** Whether this step is a tool invoked by an agent turn step */
  isAgentTool?: boolean | undefined;
  /** Name of the parent agent step, if any */
  parentAgentName?: string | undefined;
  /** Full catalog for populating dynamic dropdowns on special operations */
  catalogOperations?: CatalogOperation[] | undefined;
}

export interface SchemaProperty {
  type?: string | undefined;
  description?: string | undefined;
  enum?: unknown[] | undefined;
  anyOf?: Array<{ enum?: unknown[]; type?: string }>;
  default?: unknown;
  minimum?: number | undefined;
  maximum?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  /** For type "object": nested properties schema */
  properties?: Record<string, SchemaProperty> | undefined;
  /** For type "object": whether additional keys are allowed */
  additionalProperties?: boolean | Record<string, unknown> | undefined;
  /** For type "array": schema for each item */
  items?: SchemaProperty | SchemaProperty[] | undefined;
}
