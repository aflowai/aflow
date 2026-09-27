export type GuardrailContentType =
  'guardrail_policy' | 'guardrail_policy_list' | 'guardrail_violations' | null;

export function detectGuardrailContent(data: unknown): GuardrailContentType {
  if (!data || typeof data !== 'object') return null;

  // GuardrailViolations: array of objects with railId
  if (Array.isArray(data)) {
    const first: unknown = data[0];
    if (data.length > 0 && typeof first === 'object' && first !== null && 'railId' in first) {
      return 'guardrail_violations';
    }
    return null;
  }

  const obj = data as Record<string, unknown>;

  // GuardrailPolicy: has policyId + rails
  if ('policyId' in obj && 'rails' in obj) {
    return 'guardrail_policy';
  }

  // GuardrailPolicyList: { policies: [...], total }
  if ('policies' in obj && Array.isArray(obj['policies']) && 'total' in obj) {
    return 'guardrail_policy_list';
  }

  return null;
}
