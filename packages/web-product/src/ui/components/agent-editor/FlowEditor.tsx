'use client';

import { useState, useCallback, useEffect } from 'react';
import { useFlowEditor } from '../../hooks/use-flow-editor.js';
import type { AgentDefinition } from '../../lib/flow-to-graph.js';
import { Textarea, Text, Column, Button, Row, useBreakpoint } from '@aflow/design-system';
import { FlowCanvas } from './FlowCanvas.js';
import { VariablesPanel } from './VariablesPanel.js';
import { InspectorPanel } from './InspectorPanel/index.js';
import { ResizablePanel } from './ResizablePanel.js';
import { EditorToolbar, ValidationBar } from './EditorToolbar.js';
import { StepTypePicker } from './StepTypePicker.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlowEditorProps {
  initialFlow: AgentDefinition;
  /** Publish the flow. May return the server-saved definition (with server-side modifications). */
  onPublish: (flow: AgentDefinition) => Promise<AgentDefinition | undefined>;
  /** When set, show a "Back to chat" link (e.g. when navigating from chat) */
  backToChatHref?: string | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FlowEditor({ initialFlow, onPublish, backToChatHref }: FlowEditorProps) {
  const editor = useFlowEditor(initialFlow);
  const {
    state,
    undo,
    redo,
    addStep,
    removeStep,
    updateStep,
    selectStep,
    selectEdge,
    addTransition,
    removeTransition,
    addVariable,
    removeVariable,
    updateVariable,
    updateMetadata,
    setStartStep,
    markSaved,
    catalog,
  } = editor;

  const { isMobile } = useBreakpoint();

  const [showStepPicker, setShowStepPicker] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const showVariables = true;
  const showInspector = true;
  const [mobilePanel, setMobilePanel] = useState<'canvas' | 'variables' | 'inspector'>('canvas');
  const [showJsonView, setShowJsonView] = useState(false);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(state.flow, null, 2));
  const [jsonParseError, setJsonParseError] = useState<string | null>(null);

  // Sync JSON text when entering JSON view or when flow changes from visual editor
  useEffect(() => {
    if (showJsonView) {
      setJsonText(JSON.stringify(state.flow, null, 2));
      setJsonParseError(null);
    }
  }, [showJsonView, state.flow]);

  const handlePublish = useCallback(async () => {
    if (!state.validation.valid) return;
    setIsPublishing(true);
    setPublishError(null);
    try {
      const savedDef = await onPublish(state.flow);
      if (savedDef) {
        // Reinitialize editor with server-saved definition
        // (picks up auto-chained transitions, etc.)
        editor.dispatch({ type: 'INIT', flow: savedDef });
      } else {
        markSaved();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Publish failed';
      setPublishError(message);
    } finally {
      setIsPublishing(false);
    }
  }, [state.flow, state.validation.valid, onPublish, markSaved, editor]);

  const handleAutoLayout = useCallback(() => {
    // Force re-layout by toggling a ref — the canvas handles layout internally
    // We achieve this by dispatching a no-op metadata update to trigger re-render
    updateMetadata({});
  }, [updateMetadata]);

  const handleAddStep = useCallback(
    (
      stepType: Parameters<typeof addStep>[0],
      operationId: Parameters<typeof addStep>[1],
      name: string,
    ) => {
      addStep(stepType, operationId, name);
      setShowStepPicker(false);
    },
    [addStep],
  );

  const applyJsonEdit = useCallback(() => {
    setJsonParseError(null);
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonParseError('Flow must be a JSON object');
        return;
      }
      const flow = parsed as AgentDefinition;
      if (typeof flow.flowId !== 'string' || !Array.isArray(flow.steps)) {
        setJsonParseError('Flow must have flowId and steps');
        return;
      }
      editor.dispatch({ type: 'INIT', flow });
    } catch (err) {
      setJsonParseError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  }, [jsonText, editor]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--color-surface-raised)',
      }}
    >
      {/* Toolbar */}
      <EditorToolbar
        flowName={state.flow.metadata.name}
        isDirty={state.isDirty}
        canUndo={state.undoStack.length > 0}
        canRedo={state.redoStack.length > 0}
        validation={state.validation}
        isPublishing={isPublishing}
        showJsonView={showJsonView}
        backToChatHref={backToChatHref}
        onUndo={undo}
        onRedo={redo}
        onAutoLayout={handleAutoLayout}
        onPublish={() => {
          void handlePublish();
        }}
        onAddStep={() => {
          setShowStepPicker(true);
        }}
        onToggleJsonView={() => {
          setShowJsonView((v) => !v);
        }}
      />

      {/* Mobile panel switcher */}
      {isMobile && (
        <Row
          gap="1"
          align="center"
          style={{
            padding: 'var(--space-1) var(--space-2)',
            borderBottom: '1px solid var(--color-border-subtle)',
            background: 'var(--color-surface-canvas)',
          }}
        >
          <Button
            size="sm"
            variant={mobilePanel === 'variables' ? 'secondary' : 'ghost'}
            onClick={() => {
              setMobilePanel(mobilePanel === 'variables' ? 'canvas' : 'variables');
            }}
          >
            Variables
          </Button>
          <Button
            size="sm"
            variant={mobilePanel === 'canvas' ? 'secondary' : 'ghost'}
            onClick={() => {
              setMobilePanel('canvas');
            }}
          >
            Canvas
          </Button>
          <Button
            size="sm"
            variant={mobilePanel === 'inspector' ? 'secondary' : 'ghost'}
            onClick={() => {
              setMobilePanel(mobilePanel === 'inspector' ? 'canvas' : 'inspector');
            }}
          >
            Inspector
          </Button>
        </Row>
      )}

      {/* Main area: Variables + Canvas + Inspector */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Variables panel — desktop: resizable side panel, mobile: full-width when selected */}
        {(isMobile ? mobilePanel === 'variables' : showVariables) &&
          (isMobile ? (
            <div style={{ flex: 1, overflow: 'auto', background: 'var(--color-surface-canvas)' }}>
              <VariablesPanel
                variables={state.flow.stateVariables ?? []}
                steps={state.flow.steps ?? []}
                onAdd={addVariable}
                onRemove={removeVariable}
                onUpdate={updateVariable}
              />
            </div>
          ) : (
            <ResizablePanel
              side="right"
              defaultWidth={240}
              minWidth={180}
              maxWidth={400}
              style={{
                borderRight: '1px solid var(--color-border-subtle)',
                background: 'var(--color-surface-canvas)',
              }}
            >
              <VariablesPanel
                variables={state.flow.stateVariables ?? []}
                steps={state.flow.steps ?? []}
                onAdd={addVariable}
                onRemove={removeVariable}
                onUpdate={updateVariable}
              />
            </ResizablePanel>
          ))}

        {/* Canvas or JSON view — show on desktop always, on mobile only when 'canvas' selected */}
        {(!isMobile || mobilePanel === 'canvas') && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {showJsonView ? (
              <div
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  padding: isMobile ? 'var(--space-2)' : 'var(--space-4)',
                  background: 'var(--color-surface-raised)',
                }}
              >
                <Column gap="2" style={{ flex: 1, minHeight: 0 }}>
                  <Text size="sm" style={{ fontWeight: 600, color: 'var(--color-content-muted)' }}>
                    Flow definition (edit and blur or click Apply to update)
                  </Text>
                  {jsonParseError && (
                    <Text size="sm" style={{ color: 'var(--color-danger-default)' }}>
                      {jsonParseError}
                    </Text>
                  )}
                  <Textarea
                    value={jsonText}
                    onChange={(e) => {
                      setJsonText(e.target.value);
                      setJsonParseError(null);
                    }}
                    onBlur={applyJsonEdit}
                    placeholder="{}"
                    style={{
                      flex: 1,
                      minHeight: 200,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--font-size-xs)',
                    }}
                  />
                  <Button size="sm" variant="primary" onClick={applyJsonEdit}>
                    Apply changes
                  </Button>
                </Column>
              </div>
            ) : (
              <FlowCanvas
                flow={state.flow}
                validation={state.validation}
                selectedStepId={state.selectedStepId}
                selectedEdgeId={state.selectedEdgeId}
                onSelectStep={(stepId) => {
                  selectStep(stepId);
                  if (isMobile && stepId) setMobilePanel('inspector');
                }}
                onSelectEdge={(edgeId) => {
                  selectEdge(edgeId);
                  if (isMobile && edgeId) setMobilePanel('inspector');
                }}
                onAddTransition={addTransition}
                onRemoveStep={removeStep}
                onRemoveTransition={removeTransition}
                editable
              />
            )}
          </div>
        )}

        {/* Inspector panel — desktop: resizable side panel, mobile: full-width when selected */}
        {(isMobile ? mobilePanel === 'inspector' : showInspector) &&
          (isMobile ? (
            <div style={{ flex: 1, overflow: 'auto', background: 'var(--color-surface-canvas)' }}>
              <InspectorPanel
                flow={state.flow}
                selectedStepId={state.selectedStepId}
                selectedEdgeId={state.selectedEdgeId}
                operations={catalog.operations}
                stepTypes={catalog.stepTypes}
                onUpdateStep={updateStep}
                onRemoveStep={removeStep}
                onSetStartStep={setStartStep}
                onUpdateMetadata={updateMetadata}
                onUpdateFlowSettings={(patch) => {
                  editor.dispatch({ type: 'UPDATE_FLOW_SETTINGS', patch });
                }}
              />
            </div>
          ) : (
            <ResizablePanel
              side="left"
              defaultWidth={380}
              minWidth={280}
              maxWidth={700}
              style={{
                borderLeft: '1px solid var(--color-border-subtle)',
                background: 'var(--color-surface-canvas)',
              }}
            >
              <InspectorPanel
                flow={state.flow}
                selectedStepId={state.selectedStepId}
                selectedEdgeId={state.selectedEdgeId}
                operations={catalog.operations}
                stepTypes={catalog.stepTypes}
                onUpdateStep={updateStep}
                onRemoveStep={removeStep}
                onSetStartStep={setStartStep}
                onUpdateMetadata={updateMetadata}
                onUpdateFlowSettings={(patch) => {
                  editor.dispatch({ type: 'UPDATE_FLOW_SETTINGS', patch });
                }}
              />
            </ResizablePanel>
          ))}
      </div>

      {/* Publish error banner */}
      {publishError && (
        <Row
          align="center"
          gap="2"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--color-danger-subtle)',
            borderTop: '1px solid var(--color-danger-default)',
          }}
        >
          <Text size="sm" style={{ flex: 1, color: 'var(--color-danger-default)' }}>
            {publishError}
          </Text>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPublishError(null);
            }}
          >
            Dismiss
          </Button>
        </Row>
      )}

      {/* Validation bar */}
      <ValidationBar validation={state.validation} />

      {/* Step type picker modal */}
      {showStepPicker && (
        <StepTypePicker
          stepTypes={catalog.stepTypes}
          operations={catalog.operations}
          onSelect={handleAddStep}
          onClose={() => {
            setShowStepPicker(false);
          }}
        />
      )}
    </div>
  );
}
