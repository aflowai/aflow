/**
 * Which tool images a model is shown, decided once per request.
 *
 * A tool message keeps its images as payload references. Here, while the
 * request is built, each reference becomes either the image's bytes or a line
 * of text giving its description and size — and the adapters only ever see
 * those two forms. Nothing is read for a model that does not take images.
 */
import type { StepImage } from '@aflow/schemas';
import { AIClientError } from './errors.js';
import type {
  AIProvider,
  ChatMessage,
  ContentPart,
  ToolContentPart,
  ToolImageResolution,
  ToolImageResolver,
} from './types.js';

/** The most tool images one request carries as images. */
export const MAX_TOOL_IMAGES_PER_TURN = 6;
/** The most tool-image bytes one request carries. */
export const MAX_TOOL_IMAGE_BYTES_PER_TURN = 8 * 1024 * 1024;
/**
 * The most bytes one tool image carries — below the smallest per-image limit
 * any provider in the catalog is known to refuse over, which a single image
 * past it would turn into a failed request.
 */
export const MAX_TOOL_IMAGE_BYTES_PER_IMAGE = 4 * 1024 * 1024;
/**
 * How many of the most recent runs of tool results keep their images. A run
 * is the tool messages answering one assistant turn; older runs keep only the
 * description. More than one, because an agent often takes another step —
 * closing the page, say — before it describes what it saw.
 */
export const TOOL_RESULT_RUNS_KEEPING_IMAGES = 3;

type Reduction =
  | { kind: 'no_vision' }
  | { kind: 'earlier_result' }
  | { kind: 'over_ceiling' }
  | { kind: 'over_image_ceiling' }
  | { kind: 'unreadable'; reason: string };

interface Candidate {
  messageIndex: number;
  partIndex: number;
  image: StepImage;
  run: number;
}

type ToolMessage = Extract<ChatMessage, { role: 'tool' }>;

function describeImage(image: StepImage): string {
  return `${String(image.width)}×${String(image.height)} ${image.contentType}: ${image.description ?? 'no description given'}`;
}

function reductionReason(reduction: Reduction): string {
  switch (reduction.kind) {
    case 'no_vision':
      return 'this model does not take images';
    case 'earlier_result':
      return (
        `it is older than the last ${String(TOOL_RESULT_RUNS_KEEPING_IMAGES)} rounds of tool results; ` +
        'take the screenshot again to see it'
      );
    case 'over_ceiling':
      return (
        `this turn's image limit (${String(MAX_TOOL_IMAGES_PER_TURN)} images, ` +
        `${String(MAX_TOOL_IMAGE_BYTES_PER_TURN / (1024 * 1024))} MB) went to newer images`
      );
    case 'over_image_ceiling':
      return `it is over the ${String(MAX_TOOL_IMAGE_BYTES_PER_IMAGE / (1024 * 1024))} MB limit for one image`;
    case 'unreadable':
      return `its bytes could not be used: ${reduction.reason}`;
  }
}

/** The text an image is reduced to when the model is not shown it. */
export function reducedToolImageText(image: StepImage, reduction: Reduction): string {
  return `[Image not shown — ${reductionReason(reduction)}. ${describeImage(image)}]`;
}

function decodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Newest first, each tagged with how many tool-result runs are newer than its own. */
function collectCandidates(messages: readonly ChatMessage[]): Candidate[] {
  const candidates: Candidate[] = [];
  let run = -1;
  let inRun = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'tool') {
      inRun = false;
      continue;
    }
    if (!inRun) {
      run++;
      inRun = true;
    }
    if (typeof message.content === 'string') continue;
    for (let p = message.content.length - 1; p >= 0; p--) {
      const part = message.content[p]!;
      if (part.type === 'image_ref') {
        candidates.push({ messageIndex: i, partIndex: p, image: part.image, run });
      }
    }
  }
  return candidates;
}

export interface PrepareToolImagesOptions {
  vision: boolean;
  resolve: ToolImageResolver | undefined;
  provider: AIProvider;
}

/**
 * Replace every tool image reference with the image or with its description.
 * Returns the same array when there is no reference to replace.
 */
export async function prepareToolImages(
  messages: ChatMessage[],
  options: PrepareToolImagesOptions,
): Promise<ChatMessage[]> {
  const candidates = collectCandidates(messages);
  if (candidates.length === 0) return messages;

  const decided = new Map<
    Candidate,
    Reduction | { kind: 'shown'; data: string; mediaType: string }
  >();
  const admitted: Candidate[] = [];
  let count = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    if (!options.vision) {
      decided.set(candidate, { kind: 'no_vision' });
    } else if (candidate.run >= TOOL_RESULT_RUNS_KEEPING_IMAGES) {
      decided.set(candidate, { kind: 'earlier_result' });
    } else if (candidate.image.sizeBytes > MAX_TOOL_IMAGE_BYTES_PER_IMAGE) {
      decided.set(candidate, { kind: 'over_image_ceiling' });
    } else if (
      count >= MAX_TOOL_IMAGES_PER_TURN ||
      bytes + candidate.image.sizeBytes > MAX_TOOL_IMAGE_BYTES_PER_TURN
    ) {
      decided.set(candidate, { kind: 'over_ceiling' });
    } else {
      count++;
      bytes += candidate.image.sizeBytes;
      admitted.push(candidate);
    }
  }

  if (admitted.length > 0) {
    const resolve = options.resolve;
    if (!resolve) {
      throw new AIClientError(
        'A tool message carries an image but the request gives no way to read its bytes.',
        'invalid_request',
        options.provider,
        false,
      );
    }
    const resolutions: ToolImageResolution[] = await Promise.all(
      admitted.map((candidate) => resolve(candidate.image)),
    );
    // The declared size chose what to read; the bytes actually read are what
    // the ceilings hold to.
    let shownBytes = 0;
    admitted.forEach((candidate, index) => {
      const resolution = resolutions[index]!;
      if (!resolution.ok) {
        decided.set(candidate, { kind: 'unreadable', reason: resolution.reason });
        return;
      }
      const imageBytes = decodedLength(resolution.data);
      if (imageBytes > MAX_TOOL_IMAGE_BYTES_PER_IMAGE) {
        decided.set(candidate, { kind: 'over_image_ceiling' });
      } else if (shownBytes + imageBytes > MAX_TOOL_IMAGE_BYTES_PER_TURN) {
        decided.set(candidate, { kind: 'over_ceiling' });
      } else {
        shownBytes += imageBytes;
        decided.set(candidate, {
          kind: 'shown',
          data: resolution.data,
          mediaType: resolution.mediaType,
        });
      }
    });
  }

  const byPosition = new Map<string, Candidate>();
  for (const candidate of candidates) {
    byPosition.set(`${String(candidate.messageIndex)}:${String(candidate.partIndex)}`, candidate);
  }

  return messages.map((message, messageIndex) => {
    if (message.role !== 'tool' || typeof message.content === 'string') return message;
    const content: ToolContentPart[] = message.content.flatMap((part, partIndex) => {
      if (part.type !== 'image_ref') return [part];
      const candidate = byPosition.get(`${String(messageIndex)}:${String(partIndex)}`)!;
      const decision = decided.get(candidate)!;
      if (decision.kind === 'shown') {
        const shown: ContentPart[] = [
          { type: 'text', text: `Image ${describeImage(part.image)}` },
          {
            type: 'image',
            source: { type: 'base64', mediaType: decision.mediaType, data: decision.data },
          },
        ];
        return shown;
      }
      return [{ type: 'text', text: reducedToolImageText(part.image, decision) }];
    });
    const prepared: ToolMessage = { ...message, content };
    return prepared;
  });
}
