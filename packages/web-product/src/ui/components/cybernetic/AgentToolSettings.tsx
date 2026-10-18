'use client';
import { useAgentDirectives } from '../../hooks/useAgentDirectives.js';
import { AgentSettingsPopover, type AgentSettingsVariant } from './AgentSettingsPopover.js';
import { AgentCapabilitiesEditor } from './AgentCapabilitiesEditor.js';

export function AgentToolSettings({
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
  return (
    <AgentSettingsPopover
      open={open}
      onOpenChange={onOpenChange}
      variant={variant}
      icon="plugs-connected"
      title="Tools, skills & integrations"
      controller={controller}
      width={460}
    >
      {(directives) => (
        <AgentCapabilitiesEditor
          compact
          spaceId={spaceId}
          directives={directives}
          onChange={controller.edit}
        />
      )}
    </AgentSettingsPopover>
  );
}
