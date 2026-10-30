export function planResidentSessionMarker(
  trigger: string | undefined,
  target: { kind: string; systemRole?: string },
  input: Record<string, unknown> | undefined,
): boolean {
  const config = input?.['config'];
  return (
    trigger === 'schedule' &&
    target.kind === 'platform-role' &&
    target.systemRole === 'cybernetic-helmsman' &&
    typeof config === 'object' &&
    config !== null &&
    typeof (config as Record<string, unknown>)['scheduleId'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      (config as Record<string, string>)['scheduleId'] ?? '',
    )
  );
}
