/**
 * AIProviderAdapter - Interface for provider-specific implementations.
 */
import type { AsyncReplayGuarantee } from '@aflow/schemas';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerateJsonRequest,
  GenerateJsonResponse,
  GenerateEmbeddingRequest,
  GenerateEmbeddingResponse,
  GenerateImageRequest,
  GenerateImageResponse,
  EditImageRequest,
  GenerateVideoRequest,
  PollVideoJobRequest,
  StreamingResponse,
  VideoJobHandle,
  VideoJobPoll,
  AIProvider,
  DecideRequest,
  DecideResponse,
} from './types.js';

/**
 * Provider adapter interface.
 * Each provider (OpenAI, Anthropic, etc.) implements this interface.
 */
export interface AIProviderAdapter {
  /** Provider identifier */
  readonly provider: AIProvider;

  /**
   * Generate text (chat completion).
   */
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;

  /**
   * Generate text with streaming.
   */
  generateTextStream(request: GenerateTextRequest): StreamingResponse<GenerateTextResponse>;

  /**
   * Generate structured JSON output.
   */
  generateJson<T>(request: GenerateJsonRequest<T>): Promise<GenerateJsonResponse<T>>;

  /**
   * Generate embeddings.
   */
  generateEmbedding(request: GenerateEmbeddingRequest): Promise<GenerateEmbeddingResponse>;

  /**
   * Generate images from a text prompt.
   * Optional — providers that don't support image generation should throw.
   */
  generateImage?(request: GenerateImageRequest): Promise<GenerateImageResponse>;

  /**
   * Edit an existing image using a text prompt.
   * Optional — providers that don't support image editing should throw.
   */
  editImage?(request: EditImageRequest): Promise<GenerateImageResponse>;

  /**
   * Answer typed questions about a state. Optional — only a decision model's
   * provider implements it.
   */
  decide?(request: DecideRequest): Promise<Omit<DecideResponse, 'cost' | 'provider'>>;

  /**
   * Hand the provider the work and return as soon as it is accepted.
   *
   * Submit and poll are separate calls because a render outlives the process
   * that started it: only a durable handle lets a restarted worker resume a
   * job that has already been paid for instead of buying a second one. A
   * combined call cannot offer that at any price — the handle it holds dies
   * with the process.
   *
   * Optional: a provider without video support implements neither half.
   */
  submitVideoJob?(request: GenerateVideoRequest): Promise<VideoJobHandle>;

  /** Read a submitted job's state. Never bills, never resubmits. */
  pollVideoJob?(request: PollVideoJobRequest): Promise<VideoJobPoll>;

  /**
   * The handle a submit of this client request id will land under, known
   * before the call is made.
   *
   * Only routes whose dedupe key IS the job's address can answer: the caller
   * assigns it, so it survives a crash that loses the submit's response. That
   * turns the ambiguous window into a readable one — a replay can look the job
   * up rather than infer it — and it is why a route implementing this may be
   * polled before it is resubmitted. Absent means the handle exists only in a
   * response, and a lost response is a lost handle.
   */
  videoJobHandleFor?(clientRequestId: string): VideoJobHandle;

  /**
   * What this route can promise about a replayed submit, for the given model.
   *
   * It lives here rather than on the operation because the adapter is resolved
   * from the requested model at run time: one operation reaches providers with
   * different idempotency support, so a single static answer could only
   * overclaim for the weakest route or underclaim for the strongest. The value
   * returned is persisted on the job row, so recovery uses the guarantee that
   * was actually in force when the call was made.
   *
   * Absent means `unknown_terminal` — the safe reading, since a route that has
   * not stated a dedupe mechanism must never be resubmitted by automation.
   */
  replayGuaranteeFor?(model: string): AsyncReplayGuarantee;
}
