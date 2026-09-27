// Types
export type {
  PathResolveResult,
  PathListEntry,
  PathResolveContext,
  PayloadRetriever,
  MemoryDocReader,
  MemoryDocRecord,
  ToolOutputIndexReader,
  ToolOutputEntry,
  ToolOutputIndex,
} from './types.js';
export { normalizeToolOutputEntry } from './types.js';

// Path parsing
export {
  isVirtualPath,
  isWritablePath,
  parseOutputPath,
  RUN_PREFIX,
  RUN_OUTPUTS_PREFIX,
} from './parser.js';
export type { ParsedOutputPath } from './parser.js';

// Resolver
export { resolveMemoryPath, listVirtualOutputs, MemoryPathError } from './resolver.js';

// Output field detection (for enriching _tool_outputs)
export { detectOutputFields } from './detectOutputFields.js';

export { extractVirtualPathToolCallIds } from './extractVirtualPathToolCallIds.js';

export {
  MEMORY_READ_BUDGET_CHARS,
  packCompleteLines,
  packCompleteLineArray,
  packCompleteItems,
} from './contentPacking.js';
export type { PackedLines, PackedItems } from './contentPacking.js';

export { buildOutline, parseDottedPath, selectJsonPath, windowArray } from './structural.js';
export type {
  OutlineNode,
  OutlineOptions,
  PathSegment,
  SelectResult,
  WindowResult,
} from './structural.js';
