/**
 * The decision card on the plan rail (Plan 337 D3): how the operator's answers
 * to its open questions become words the engine already stores. An answer on
 * **Decide** lands in the outcome. An answer on **Approve** lands in the note
 * as one `Approved: …` line. No write path carries the card's answers apart.
 */
import type { PlanNodeCard } from '@aflow/schemas';

type CardQuestion = PlanNodeCard['questions'][number];

/** An end of a sentence, a closing quote or bracket after it allowed. */
const CLOSED = /[.!?…]["'”’)\]]*$/;

/**
 * One question and its answer as one line. The engine folds the lines of an
 * approve into one note line, with one space between them. So each line ends
 * with a full stop where its answer has no closing punctuation.
 */
export function planCardAnswerLine(question: string, answer: string): string {
  const words = answer.trim();
  return `${question} Answer: ${CLOSED.test(words) ? words : `${words}.`}`;
}

/** What **Decide** opens with on a carded decision: each question and its recommended answer. */
export function planCardDecidePrefill(card: PlanNodeCard | undefined): string {
  return (card?.questions ?? [])
    .map((q) => planCardAnswerLine(q.question, q.recommended))
    .join('\n');
}

/**
 * The one `why` an **Approve** sends: a line for each question, the operator's
 * answer where they wrote one and the recommended answer where they did not,
 * then their instructions. With no question and no instructions it is absent.
 */
export function planCardApproveWhy(
  questions: readonly CardQuestion[],
  answers: readonly string[],
  instructions: string,
): string | undefined {
  const lines = questions.map((q, index) => {
    const written = answers[index]?.trim() ?? '';
    return planCardAnswerLine(q.question, written.length > 0 ? written : q.recommended);
  });
  const words = instructions.trim();
  if (words.length > 0) lines.push(words);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Where **Read the plan** points. A document link holds a URL, or the path
 * and the sha in a folder with no remote. A URL opens, and a path is text.
 */
export function planDocumentTarget(ref: string): { href: string } | { text: string } {
  return /^https?:\/\/\S+$/.test(ref) ? { href: ref } : { text: ref };
}
