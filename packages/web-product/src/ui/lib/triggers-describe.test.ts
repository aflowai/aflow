/**
 * The point of this page is that an operator can read it. A cron expression
 * shown raw is a thing you decode, so these cover the shapes people schedule —
 * and, more importantly, that an expression it does not understand keeps its
 * own text instead of getting a confident wrong sentence.
 */
import { describe, expect, it } from 'vitest';

import { describeCron, describeWork } from './triggers-describe.js';

describe('saying when a schedule happens', () => {
  it('reads the everyday shapes as sentences', () => {
    expect(describeCron('0 9 * * *', 'UTC')).toBe('Every day at 09:00 UTC');
    expect(describeCron('30 6 * * 1-5', 'Europe/Berlin')).toBe('Weekdays at 06:30 Europe/Berlin');
    expect(describeCron('0 18 * * 5', 'UTC')).toBe('Every Friday at 18:00 UTC');
    expect(describeCron('0 3 1 * *', 'UTC')).toBe('Monthly on day 1 at 03:00 UTC');
    expect(describeCron('0 * * * *', 'UTC')).toBe('Every hour UTC');
    expect(describeCron('*/15 * * * *', 'UTC')).toBe('Every 15 minutes');
  });

  it('keeps the expression when it cannot say it plainly', () => {
    // An operator can look a cron string up. They cannot tell that a friendly
    // sentence is describing a different schedule than the one that will run.
    for (const odd of ['0 9 1-7 * 1', '15,45 2 * 3 *', 'not a cron']) {
      expect(describeCron(odd, 'UTC')).toContain(odd);
    }
  });

  it('names the timezone, since 09:00 means nothing without it', () => {
    expect(describeCron('0 9 * * *', 'Asia/Tokyo')).toContain('Asia/Tokyo');
  });
});

describe('saying what a schedule will do', () => {
  it('finds the instruction wherever it was put', () => {
    expect(describeWork({ message: 'Summarise yesterday' })).toBe('Summarise yesterday');
    expect(describeWork({ prompt: 'Check the repo' })).toBe('Check the repo');
  });

  it('says nothing rather than dumping the template', () => {
    // A blob of JSON answers a question nobody asked and pushes the useful part
    // of the row off the screen.
    expect(describeWork({ someConfig: { nested: true } })).toBeNull();
    expect(describeWork({})).toBeNull();
    expect(describeWork(undefined)).toBeNull();
    expect(describeWork({ message: '   ' })).toBeNull();
  });
});
