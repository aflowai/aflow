import type { StoreArtifactType } from '@aflow/schemas';

export const ARTIFACT_TYPE_LABELS: Record<StoreArtifactType, string> = {
  skill: 'Skill',
  api_definition: 'Integration',
  api_binding: 'Connection',
  mcp_definition: 'Integration',
  mcp_binding: 'Connection',
  memory_doc: 'Document',
  ui_artifact: 'Card',
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function titleCaseId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(titleCase)
    .join(' ');
}
