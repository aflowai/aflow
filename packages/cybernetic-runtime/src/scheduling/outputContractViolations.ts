import AjvModule from 'ajv';

// `ajv` ships its constructor as the package default in ESM and as the module
// shape in CJS, as `campaignConfig.ts` reads it.
const AjvCtor = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as unknown as new (opts?: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => ((data: unknown) => boolean) & {
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
let ajv: InstanceType<typeof AjvCtor> | undefined;

/**
 * The ways `output` breaks a task's `outputContract.schema`, at most ten, each
 * naming the path it breaks at. Empty means the output holds the schema. The
 * orchestrator refuses an agent task's output on the same JSON Schema check.
 */
export function outputContractViolations(
  schema: Record<string, unknown>,
  output: unknown,
): string[] {
  ajv ??= new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(output)) return [];
  return (validate.errors ?? [])
    .slice(0, 10)
    .map((e) => `${e.instancePath || '<root>'}: ${e.message ?? 'invalid'}`);
}
