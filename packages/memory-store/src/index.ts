export {
  writeMemoryDoc,
  writeStructuralDoc,
  runOrigin,
  MemoryWriteDeniedError,
  MEMORY_INLINE_THRESHOLD,
  type MemoryWriteContent,
  type MemoryWriteLogger,
  type MemoryWriteOrigin,
  type WriteMemoryDocParams,
  type WriteMemoryDocResult,
} from './writeDoc.js';

export {
  prepareDerivedIndexes,
  prepareStructuralIndexes,
  commitDerivedIndexes,
  type PreparedDerivation,
  type CommitDerivedIndexesContext,
  type CommitDerivedIndexesResult,
  type DerivationReport,
  type DerivationLinkReport,
  type DerivationPropertyReport,
} from './derivation.js';

export { computeContentHash, computeBytesHash, makePreview } from './contentUtils.js';

export {
  governedPathRefusal,
  taskDraftReadRefusal,
  isTaskDraftPath,
  governedSubtreeRefusal,
  isGovernedEvalSuitePath,
  isPlatformEvidencePath,
  isGeneratedMediaPath,
  GENERATED_MEDIA_PREFIX,
  type GovernedWriter,
} from './governedPaths.js';

export {
  bytesAreUtf8,
  hasBinaryExtension,
  isBinaryContent,
  isBinaryPayloadRef,
} from './binaryDetection.js';

export {
  chunkContent,
  chunkText,
  chunkJson,
  chunkCsv,
  parseCsvLine,
  splitForTokenSafety,
  isBinaryDocType,
  type ContentChunk,
  type CsvChunkMeta,
} from './chunker.js';

export {
  MAX_LINKS_PER_DOC,
  LINK_CONTEXT_CHARS,
  LINK_TARGET_MAX_BYTES,
  LINK_SCAN_BYTES,
  FRONTMATTER_SCAN_BYTES,
  MAX_PROPERTY_KEYS,
  MAX_PROPERTY_VALUE_CHARS,
  MAX_PROPERTY_ARRAY_ITEMS,
  MAX_PROPERTIES_BYTES,
  INDEX_ENTRY_HOOK_CHARS,
  INDEX_NOTE_MAX_ENTRIES,
  LINKABLE_DOC_TYPES,
  isLinkableDocType,
} from './linkConstants.js';

export {
  parseWikilinks,
  canonicalizeTarget,
  sanitizeInjectedText,
  neutralizeWikilinks,
  type ParsedLink,
  type LinkParseResult,
} from './links.js';

export {
  parseFrontmatter,
  type PropertyValue,
  type FrontmatterDiagnostic,
  type FrontmatterResult,
} from './frontmatter.js';

export {
  parseIndexNote,
  INDEX_NOTE_PATH,
  type IndexEntry,
  type IndexParseResult,
} from './indexNote.js';

export {
  assertIndexNoteHash,
  isIndexNotePath,
  MemoryHashRequiredError,
  MEMORY_HASH_REQUIRED_MESSAGE,
} from './indexNoteGuard.js';
export {
  saveBytesToMemoryDoc,
  type SaveBytesToMemoryDocParams,
  type SaveBytesToMemoryDocResult,
} from './saveBytes.js';
export { workspacePathToMemoryPath } from './saveBytes.js';
export {
  readMemoryBodyBytes,
  readPinnedMemoryDoc,
  PinnedMemoryReadError,
  type MemoryBodyLocation,
  type PinnedMemoryContent,
  type PinnedReadFailure,
  type PinnedReadPayloadStore,
  type ReadPinnedMemoryDocParams,
} from './readPinned.js';
