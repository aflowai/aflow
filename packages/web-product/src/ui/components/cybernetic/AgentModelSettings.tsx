'use client';

import { useCallback, useState } from 'react';
import {
  agentModelForRef,
  conversationSummariesEnabled,
  type DirectiveReasoningEffort,
  type EntityDirectives,
} from '@aflow/schemas';
import { useChatModelOptions } from '../../hooks/useChatModelOptions.js';
import { useSpaceLlmReadiness } from '../../hooks/useSpaceLlmReadiness.js';
import { useAgentDirectives } from '../../hooks/useAgentDirectives.js';
import { ConnectProviderDialog } from '../credentials/ConnectProviderDialog.js';
import {
  ModelDefaultsEditor,
  applyModelRoleChange,
  applyReasoningRoleChange,
} from './ModelDefaultsEditor.js';
import type { ModelRole } from './ModelDefaultsEditor.js';
import { AgentSettingsPopover, type AgentSettingsVariant } from './AgentSettingsPopover.js';

/**
 * In-composer shortcut for which model answers, and how hard it thinks — the
 * knobs an operator reaches for often enough that a trip to the settings tab is
 * friction.
 */
export function AgentModelSettings({
  spaceId,
  open,
  onOpenChange,
  variant = 'chip',
}: {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: AgentSettingsVariant;
}) {
  const controller = useAgentDirectives(spaceId, open);
  const { edit } = controller;
  // Whatever this space already holds stays listed even if the tenant has since
  // narrowed the set — it is still the model the space runs on.
  const storedModelRefs = Object.values(controller.directives?.modelDefaults ?? {}).filter(
    (v): v is string => typeof v === 'string',
  );
  const { modelOptions, clerkModelOptions, modelOptionsLoading, modelOptionsError } =
    useChatModelOptions(storedModelRefs);
  const { readiness } = useSpaceLlmReadiness(open ? spaceId : null);
  const [connectProvider, setConnectProvider] = useState<string | null>(null);

  const onModelChange = useCallback(
    (role: ModelRole, value: string | undefined) => {
      edit((d): EntityDirectives => ({
        ...d,
        modelDefaults: applyModelRoleChange(d.modelDefaults, role, value),
      }));
    },
    [edit],
  );

  const onReasoningChange = useCallback(
    (role: ModelRole, value: DirectiveReasoningEffort | undefined) => {
      edit((d): EntityDirectives => ({
        ...d,
        reasoningDefaults: applyReasoningRoleChange(d.reasoningDefaults, role, value),
      }));
    },
    [edit],
  );

  return (
    <>
      <AgentSettingsPopover
        open={open}
        onOpenChange={onOpenChange}
        variant={variant}
        icon="sliders"
        title="Models & reasoning"
        controller={controller}
      >
        {(directives) => (
          <ModelDefaultsEditor
            modelDefaults={directives.modelDefaults}
            reasoningDefaults={directives.reasoningDefaults}
            modelOptions={modelOptions}
            clerkModelOptions={clerkModelOptions}
            clerkReadiness={readiness?.clerk ?? null}
            conversationSummaries={conversationSummariesEnabled(directives)}
            onConversationSummariesChange={(next) => {
              edit((d): EntityDirectives => ({ ...d, conversationSummaries: next }));
            }}
            loading={modelOptionsLoading}
            error={modelOptionsError}
            onModelChange={onModelChange}
            onReasoningChange={onReasoningChange}
            variant="compact"
            missingProviderForRef={(ref) => {
              if (!readiness || readiness.ready) return null;
              // The catalog knows every model's provider; the recommended
              // registry knows only the curated refs, so a tenant-enabled
              // model resolved through it alone would never offer to connect.
              const provider =
                modelOptions.find(
                  (o) => o.id === ref || o.aliases.includes(ref) || o.retiredRefs.includes(ref),
                )?.provider ?? agentModelForRef(ref)?.credentialProviderId;
              if (!provider) return null;
              const unready =
                readiness.missingProviders.some((p) => p.providerId === provider) ||
                readiness.erroredProviders.some((p) => p.providerId === provider);
              return unready ? provider : null;
            }}
            onConnectProvider={setConnectProvider}
          />
        )}
      </AgentSettingsPopover>
      <ConnectProviderDialog
        open={connectProvider !== null}
        providerId={connectProvider}
        spaceId={spaceId}
        onClose={() => {
          setConnectProvider(null);
        }}
      />
    </>
  );
}
