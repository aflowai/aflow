export function planResidentSessionMarker(
  trigger: string | undefined,
  target: { kind: string; systemRole?: string },
  residentScheduleId: string | undefined,
): boolean {
  return (
    trigger === 'schedule' &&
    target.kind === 'platform-role' &&
    target.systemRole === 'cybernetic-helmsman' &&
    typeof residentScheduleId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(residentScheduleId)
  );
}
