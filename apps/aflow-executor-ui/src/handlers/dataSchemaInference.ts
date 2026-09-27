export interface InferredSchemaResult {
  schema: Record<string, unknown>;
  provenance: 'data_inferred';
}

function uniquePrimitiveTypes(values: unknown[]): string[] {
  const types = new Set<string>();
  for (const value of values) {
    if (value === null) {
      types.add('null');
    } else if (Array.isArray(value)) {
      types.add('array');
    } else {
      types.add(typeof value);
    }
  }
  return [...types];
}

function inferSchemaFromSamples(values: unknown[]): Record<string, unknown> {
  if (values.length === 0) {
    return {};
  }

  const objectItems = values.filter(
    (value): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  if (objectItems.length === values.length) {
    return mergeObjectSchemas(objectItems);
  }

  const arrayItems = values.filter(Array.isArray);
  if (arrayItems.length === values.length) {
    return {
      type: 'array',
      items: inferArrayItemsSchema(values.flatMap((value) => value as unknown[])),
    };
  }

  const primitiveTypes = uniquePrimitiveTypes(values);
  if (primitiveTypes.length === 1) {
    return inferJsonSchema(values[0]);
  }

  return {
    anyOf: primitiveTypes.map((type) =>
      type === 'null' ? ({ type: 'null' } as Record<string, unknown>) : { type },
    ),
  };
}

function mergeObjectSchemas(items: Array<Record<string, unknown>>): Record<string, unknown> {
  const propertyValues = new Map<string, unknown[]>();
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      const existing = propertyValues.get(key);
      if (existing) {
        existing.push(value);
      } else {
        propertyValues.set(key, [value]);
      }
    }
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, values] of propertyValues.entries()) {
    properties[key] = inferSchemaFromSamples(values);
    if (values.length === items.length) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function inferArrayItemsSchema(items: unknown[]): Record<string, unknown> {
  if (items.length === 0) {
    return {};
  }

  const objectItems = items.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  );

  if (objectItems.length === items.length) {
    return mergeObjectSchemas(objectItems);
  }

  return inferSchemaFromSamples(items);
}

export function inferJsonSchema(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: inferArrayItemsSchema(value),
    };
  }

  if (value === null) {
    return { type: 'null' };
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, child] of Object.entries(objectValue)) {
      properties[key] = inferJsonSchema(child);
      required.push(key);
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (typeof value === 'string') {
    return { type: 'string' };
  }

  if (typeof value === 'number') {
    return { type: 'number' };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }

  return {};
}

export function inferDataSchemaFromData(data: Record<string, unknown>): InferredSchemaResult {
  return {
    schema: inferJsonSchema(data),
    provenance: 'data_inferred',
  };
}
