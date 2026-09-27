/**
 * AI provider config for inline vector search.
 */
export function buildProviders(): Record<string, { apiKey: string; organization?: string }> {
  const providers: Record<string, { apiKey: string; organization?: string }> = {};
  if (process.env['OPENAI_API_KEY']) {
    providers['openai'] = {
      apiKey: process.env['OPENAI_API_KEY'],
      ...(process.env['OPENAI_ORG_ID'] ? { organization: process.env['OPENAI_ORG_ID'] } : {}),
    };
  }
  if (process.env['GEMINI_API_KEY']) {
    providers['google'] = { apiKey: process.env['GEMINI_API_KEY'] };
  }
  if (process.env['OPENROUTER_API_KEY']) {
    providers['openrouter'] = { apiKey: process.env['OPENROUTER_API_KEY'] };
  }
  return providers;
}
