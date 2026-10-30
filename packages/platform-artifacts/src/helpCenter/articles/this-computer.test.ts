import { expect, it } from 'vitest';
import { THIS_COMPUTER_ARTICLES } from './this-computer.js';

it('describes retryable reads and the blocked fallback when a merge wait line cannot fit', () => {
  const body = THIS_COMPUTER_ARTICLES.map((article) => article.body).join('\n');
  expect(body).toContain('A failed GitHub read leaves the step open for another wake to retry.');
  expect(body).toContain(
    'If the note has no room for that line, the step becomes blocked instead.',
  );
});
