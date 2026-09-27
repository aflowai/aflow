/**
 * A run can park twice on the same step asking different things. The step id
 * alone would let an answer to the first question apply to the second.
 */
import { describe, expect, it } from 'vitest';
import { derivePauseToken } from './pauseToken.js';

const STEP = '00000000-0000-4000-8000-0000000000bb';
const OTHER_STEP = '00000000-0000-4000-8000-0000000000cc';

describe('derivePauseToken', () => {
  it('is stable for the same pause', () => {
    expect(derivePauseToken({ stepExecutionId: STEP, requestedInputRef: 'inline:abc' })).toBe(
      derivePauseToken({ stepExecutionId: STEP, requestedInputRef: 'inline:abc' }),
    );
  });

  it('changes when the same step asks something else', () => {
    expect(derivePauseToken({ stepExecutionId: STEP, requestedInputRef: 'inline:abc' })).not.toBe(
      derivePauseToken({ stepExecutionId: STEP, requestedInputRef: 'inline:xyz' }),
    );
  });

  it('changes when a different step asks the same thing', () => {
    expect(derivePauseToken({ stepExecutionId: STEP, requestedInputRef: 'inline:abc' })).not.toBe(
      derivePauseToken({ stepExecutionId: OTHER_STEP, requestedInputRef: 'inline:abc' }),
    );
  });

  it('handles a pause carrying no request', () => {
    const token = derivePauseToken({ stepExecutionId: STEP });
    expect(token).toHaveLength(16);
    expect(token).toBe(derivePauseToken({ stepExecutionId: STEP, requestedInputRef: null }));
  });

  it('cannot be confused by parts that re-split across the boundary', () => {
    expect(derivePauseToken({ stepExecutionId: 'a', requestedInputRef: 'bc' })).not.toBe(
      derivePauseToken({ stepExecutionId: 'ab', requestedInputRef: 'c' }),
    );
    expect(derivePauseToken({ stepExecutionId: 'a', requestedInputRef: '1:b' })).not.toBe(
      derivePauseToken({ stepExecutionId: 'a1', requestedInputRef: 'b' }),
    );
  });
});
