export function serializeMessage(message: Record<string, unknown>): string[] {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(message)) {
    if (value !== undefined && value !== null) {
      fields.push(key);
      if (typeof value === 'object') {
        fields.push(JSON.stringify(value));
      } else if (typeof value === 'string') {
        fields.push(value);
      } else if (typeof value === 'number') {
        fields.push(String(value));
      } else if (typeof value === 'boolean') {
        fields.push(value ? 'true' : 'false');
      } else if (typeof value === 'bigint') {
        fields.push(value.toString());
      } else {
        fields.push(JSON.stringify(value));
      }
    }
  }
  return fields;
}

/** Deserialize Redis stream fields to a message object. */
export function deserializeMessage(fields: Record<string, string>): Record<string, unknown> {
  const message: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    try {
      message[key] = JSON.parse(value);
    } catch {
      message[key] = value;
    }
  }
  return message;
}
