/**
 * Saying what a schedule does, in words an operator would use.
 *
 * A cron expression is a fact about a schedule, not an answer to "when does
 * this happen". Shown raw it makes the page technically complete and
 * practically useless: `0 9 * * 1-5` is a thing you decode, not a thing you
 * read. The common shapes are worth naming; anything unusual keeps its
 * expression rather than getting a confident wrong description.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function timeOfDay(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/**
 * A sentence for the shapes people actually schedule, and the expression itself
 * for everything else. Returning a guess for an expression this does not
 * understand would be worse than the expression: an operator can look a cron
 * string up, but cannot tell that a friendly sentence is wrong.
 */
export function describeCron(expression: string, timezone: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return `${expression} (${timezone})`;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const at = timeOfDay(minute, hour);
  const zone = ` ${timezone}`;

  if (at !== null && dayOfMonth === '*' && month === '*') {
    if (dayOfWeek === '*') return `Every day at ${at}${zone}`;
    if (dayOfWeek === '1-5') return `Weekdays at ${at}${zone}`;
    if (dayOfWeek === '0,6' || dayOfWeek === '6,0') return `Weekends at ${at}${zone}`;
    if (/^\d$/.test(dayOfWeek)) {
      const day = DAYS[Number(dayOfWeek) % 7];
      if (day !== undefined) return `Every ${day} at ${at}${zone}`;
    }
  }

  if (at !== null && month === '*' && dayOfWeek === '*' && /^\d{1,2}$/.test(dayOfMonth)) {
    return `Monthly on day ${dayOfMonth} at ${at}${zone}`;
  }

  if (hour === '*' && /^\d{1,2}$/.test(minute)) {
    return minute === '0' ? `Every hour${zone}` : `Hourly at ${minute} past${zone}`;
  }

  if (minute.startsWith('*/') && hour === '*') {
    return `Every ${minute.slice(2)} minutes`;
  }

  return `${expression} (${timezone})`;
}

/**
 * What the run will be asked to do.
 *
 * The input template is free-form, so this looks for the field an instruction
 * usually lands in and says nothing when it finds none — a dump of JSON answers
 * a question nobody asked and pushes the useful part off the row.
 */
export function describeWork(inputTemplate: Record<string, unknown> | undefined): string | null {
  if (!inputTemplate) return null;
  for (const key of ['message', 'prompt', 'instruction', 'task', 'input', 'goal']) {
    const value = inputTemplate[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}
