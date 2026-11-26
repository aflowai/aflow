/**
 * The Alpaca exchange calendar as a cycle test answers its read-exchange-calendar
 * task: a regular session on every weekday of the window the read names.
 */
export function exchangeCalendar(input: Record<string, unknown>) {
  const params = input['params'] as { start: string; end: string };
  const data: { date: string; open: string; close: string }[] = [];
  for (
    let at = new Date(`${params.start}T00:00:00Z`);
    at.toISOString().slice(0, 10) <= params.end;
  ) {
    const day = at.getUTCDay();
    if (day !== 0 && day !== 6)
      data.push({ date: at.toISOString().slice(0, 10), open: '09:30', close: '16:00' });
    at = new Date(at.getTime() + 86_400_000);
  }
  return { data };
}
