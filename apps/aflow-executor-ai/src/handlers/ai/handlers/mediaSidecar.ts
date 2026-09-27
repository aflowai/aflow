/**
 * The text note written beside every render.
 *
 * A stored image or clip is never chunked and never embedded, so nothing about
 * it is searchable and nothing links to it — a library of them is write-only.
 * This note is the searchable half of the asset: it carries the prompt, the
 * route, the shot context and the wikilinks that make the asset and its receipt
 * reachable from what points at them.
 */
import type { MediaAsset, MediaAssetKind, MediaGenerationReceipt } from '@aflow/schemas';
import { neutralizeWikilinks, sanitizeInjectedText } from '@aflow/memory-store';

export interface MediaSidecarParams {
  kind: MediaAssetKind;
  operationId: string;
  assets: MediaAsset[];
  receipt: MediaGenerationReceipt;
  receiptPath: string;
}

const TITLE_PROMPT_CHARS = 90;

/**
 * Quoted because one malformed line drops the WHOLE frontmatter block: an
 * unquoted `#` or `: ` inside a provider id would take every other property
 * with it.
 */
function frontmatterString(value: string): string {
  const escaped = sanitizeInjectedText(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function titleFor(kind: MediaAssetKind, prompt: string): string {
  const oneLine = neutralizeWikilinks(prompt.replace(/\s+/g, ' ').trim());
  if (oneLine.length === 0) return `Generated ${kind}`;
  const excerpt =
    oneLine.length > TITLE_PROMPT_CHARS
      ? `${oneLine.slice(0, TITLE_PROMPT_CHARS).trimEnd()}…`
      : oneLine;
  return `${kind === 'video' ? 'Clip' : 'Image'} — ${excerpt}`;
}

export function buildMediaSidecar(params: MediaSidecarParams): string {
  const { kind, operationId, assets, receipt, receiptPath } = params;
  const { execution, request, cost, rendered } = receipt;

  const properties: string[] = [
    `kind: ${kind}`,
    `operation: ${frontmatterString(operationId)}`,
    `provider: ${frontmatterString(receipt.provider)}`,
    `model: ${frontmatterString(receipt.model)}`,
    `route: ${frontmatterString(receipt.capabilityRoute.routeId)}`,
    `candidates: ${String(assets.length)}`,
    `renderedAt: ${frontmatterString(receipt.createdAt)}`,
    `runId: ${frontmatterString(execution.runId)}`,
  ];
  if (rendered.durationSeconds !== undefined) {
    properties.push(`durationSeconds: ${String(rendered.durationSeconds)}`);
  }
  if (execution.providerJobId !== undefined) {
    properties.push(`providerJobId: ${frontmatterString(execution.providerJobId)}`);
  }
  if (cost.actual !== undefined) {
    properties.push(`costCurrency: ${frontmatterString(cost.actual.currency)}`);
    properties.push(`costMicros: ${String(cost.actual.micros)}`);
  }

  const lines: string[] = ['---', ...properties, '---', ''];
  lines.push(`# ${titleFor(kind, request.prompt)}`, '');
  lines.push('## Prompt', '', neutralizeWikilinks(request.prompt), '');
  if (request.negativePrompt !== undefined) {
    lines.push('## Negative prompt', '', neutralizeWikilinks(request.negativePrompt), '');
  }

  lines.push('## Assets', '');
  for (const asset of assets) {
    const facts = [asset.mimeType, `${String(asset.sizeBytes)} bytes`];
    lines.push(
      `- candidate ${String(asset.candidateIndex)} — [[${asset.path}]] (${facts.join(', ')}, version ${String(asset.version)})`,
    );
    if (asset.revisedPrompt !== undefined) {
      lines.push(`  - rendered prompt: ${neutralizeWikilinks(asset.revisedPrompt)}`);
    }
  }
  lines.push('');

  if (request.boundEntityVersions.length > 0) {
    lines.push('## References', '');
    for (const bound of request.boundEntityVersions) {
      const label = bound.label === undefined ? '' : ` “${neutralizeWikilinks(bound.label)}”`;
      lines.push(`- ${bound.role}${label} — [[${bound.path}]] (version ${String(bound.version)})`);
    }
    lines.push('');
  }

  lines.push('## Receipt', '', `[[${receiptPath}]]`, '');
  return lines.join('\n');
}
