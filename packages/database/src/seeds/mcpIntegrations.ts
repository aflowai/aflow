import type postgres from 'postgres';

export async function seedMcpIntegrations(_sqlClient: postgres.Sql): Promise<{
  success: string[];
  skipped: string[];
  failed: Array<{ schema: string; error: unknown }>;
}> {
  return {
    success: [],
    skipped: [],
    failed: [],
  };
}
