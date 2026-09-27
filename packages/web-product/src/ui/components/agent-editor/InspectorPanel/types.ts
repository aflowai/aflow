import type { StepType } from '@aflow/schemas';
import type { AgentDefinition, StepDefinition } from '../../../lib/flow-to-graph.js';
import type { CatalogOperation, CatalogStepType } from '../../../hooks/use-operation-catalog.js';

export interface InspectorPanelProps {
  flow: AgentDefinition;
  selectedStepId: string | null;
  selectedEdgeId: string | null;
  operations: CatalogOperation[];
  stepTypes: CatalogStepType[];
  onUpdateStep: (stepId: string, patch: Partial<StepDefinition>) => void;
  onRemoveStep: (stepId: string) => void;
  onSetStartStep: (stepId: string) => void;
  onUpdateMetadata: (metadata: Partial<AgentDefinition['metadata']>) => void;
  onUpdateFlowSettings: (
    patch: Partial<Pick<AgentDefinition, 'supportedModes' | 'defaultBudgets'>>,
  ) => void;
}

export interface OperationGroup {
  groupId: string;
  stepType: StepType;
  group: string | null;
  label: string;
  ops: CatalogOperation[];
}

/** Extract property-level schema info from a JSON Schema object. */
export interface ConfigSchemaProperty {
  type?: string | undefined;
  description?: string | undefined;
  enum?: unknown[] | undefined;
  anyOf?: Array<{ enum?: unknown[]; type?: string }>;
  default?: unknown;
  minimum?: number | undefined;
  maximum?: number | undefined;
  maxLength?: number | undefined;
}
