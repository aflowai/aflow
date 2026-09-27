'use client';

import type { InspectorPanelProps } from './types.js';
import { EdgeInspector } from './EdgeInspector.js';
import { StepInspector } from './StepInspector.js';
import { FlowSettingsInspector } from './FlowSettingsInspector.js';

export function InspectorPanel({
  flow,
  selectedStepId,
  selectedEdgeId,
  operations,
  stepTypes,
  onUpdateStep,
  onRemoveStep,
  onSetStartStep,
  onUpdateMetadata,
  onUpdateFlowSettings,
}: InspectorPanelProps) {
  const selectedStep = selectedStepId ? flow.steps.find((s) => s.stepId === selectedStepId) : null;

  if (selectedEdgeId) {
    return <EdgeInspector edgeId={selectedEdgeId} flow={flow} onUpdateStep={onUpdateStep} />;
  }

  if (selectedStep) {
    return (
      <StepInspector
        step={selectedStep}
        flow={flow}
        operations={operations}
        stepTypes={stepTypes}
        onUpdate={(patch) => {
          onUpdateStep(selectedStep.stepId, patch);
        }}
        onRemove={() => {
          onRemoveStep(selectedStep.stepId);
        }}
        onSetAsStart={() => {
          onSetStartStep(selectedStep.stepId);
        }}
        isStartStep={flow.startStepId === selectedStep.stepId}
      />
    );
  }

  return (
    <FlowSettingsInspector
      flow={flow}
      onUpdateMetadata={onUpdateMetadata}
      onUpdateFlowSettings={onUpdateFlowSettings}
    />
  );
}
