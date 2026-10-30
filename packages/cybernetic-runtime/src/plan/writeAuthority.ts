export function restrictedPlanWriteAuthority(
  state: {
    trigger?: string | undefined;
    planResident?: boolean | undefined;
    activatedByPerson?: boolean | undefined;
  } | null,
): boolean {
  if (!state?.trigger) return true;
  if (state.trigger === 'schedule') return state.planResident !== false;
  return !['chat', 'voice'].includes(state.trigger) && state.activatedByPerson !== true;
}
