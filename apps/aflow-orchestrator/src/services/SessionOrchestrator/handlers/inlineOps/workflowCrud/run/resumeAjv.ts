import AjvModule from 'ajv';

const ResumeAjvCtor = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as unknown as new (opts?: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => (data: unknown) => boolean;
  errors?: Array<{ instancePath: string; message?: string }>;
};

let _resumeAjv: InstanceType<typeof ResumeAjvCtor> | undefined;

export function getResumeAjv(): InstanceType<typeof ResumeAjvCtor> {
  if (!_resumeAjv) _resumeAjv = new ResumeAjvCtor({ allErrors: true, strict: false });
  return _resumeAjv;
}
