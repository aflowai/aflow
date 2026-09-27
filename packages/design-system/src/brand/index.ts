/**
 * Curated, self-hosted brand marks for store listings.
 *
 * Sources: Simple Icons (CC0) or the vendor's official asset kit — see each
 * component header. No external image hosts; assets ship with the app. Every
 * `IconRef` brand `assetId` must resolve here; unknown ids fall back to the
 * listing's initials avatar.
 */
import type { ComponentType } from 'react';

import type { CustomIconProps } from '../icons/custom/types.js';
import { AirtableMark } from './AirtableMark.js';
import { AlpacaMark } from './AlpacaMark.js';
import { AnthropicMark } from './AnthropicMark.js';
import { ArxivMark } from './ArxivMark.js';
import { BraveMark } from './BraveMark.js';
import { CloudflareMark } from './CloudflareMark.js';
import { DeepSeekMark } from './DeepSeekMark.js';
import { GithubMark } from './GithubMark.js';
import { GmailMark } from './GmailMark.js';
import { GoogleCalendarMark } from './GoogleCalendarMark.js';
import { GoogleGeminiMark } from './GoogleGeminiMark.js';
import { GoogleSheetsMark } from './GoogleSheetsMark.js';
import { JiraMark } from './JiraMark.js';
import { KaggleMark } from './KaggleMark.js';
import { LinearMark } from './LinearMark.js';
import { MiniMaxMark } from './MiniMaxMark.js';
import { MoonshotAiMark } from './MoonshotAiMark.js';
import { NotionMark } from './NotionMark.js';
import { OpenAiMark } from './OpenAiMark.js';
import { OpenRouterMark } from './OpenRouterMark.js';
import { PubmedMark } from './PubmedMark.js';
import { QwenMark } from './QwenMark.js';
import { ResendMark } from './ResendMark.js';
import { SemanticScholarMark } from './SemanticScholarMark.js';
import { SentryMark } from './SentryMark.js';
import { SlackMark } from './SlackMark.js';
import { StripeMark } from './StripeMark.js';
import { TwilioMark } from './TwilioMark.js';
import { VercelMark } from './VercelMark.js';
import { WikipediaMark } from './WikipediaMark.js';
import { ZaiMark } from './ZaiMark.js';

export {
  AirtableMark,
  AlpacaMark,
  AnthropicMark,
  ArxivMark,
  BraveMark,
  CloudflareMark,
  DeepSeekMark,
  GithubMark,
  GmailMark,
  GoogleCalendarMark,
  GoogleGeminiMark,
  GoogleSheetsMark,
  JiraMark,
  KaggleMark,
  LinearMark,
  MiniMaxMark,
  MoonshotAiMark,
  NotionMark,
  OpenAiMark,
  OpenRouterMark,
  PubmedMark,
  QwenMark,
  ResendMark,
  SemanticScholarMark,
  SentryMark,
  SlackMark,
  StripeMark,
  TwilioMark,
  VercelMark,
  WikipediaMark,
  ZaiMark,
};

export const BRAND_ASSETS = {
  github: GithubMark,
  jira: JiraMark,
  alpaca: AlpacaMark,
  kaggle: KaggleMark,
  notion: NotionMark,
  linear: LinearMark,
  airtable: AirtableMark,
  stripe: StripeMark,
  twilio: TwilioMark,
  brave: BraveMark,
  resend: ResendMark,
  wikipedia: WikipediaMark,
  arxiv: ArxivMark,
  pubmed: PubmedMark,
  'semantic-scholar': SemanticScholarMark,
  slack: SlackMark,
  cloudflare: CloudflareMark,
  gmail: GmailMark,
  'google-calendar': GoogleCalendarMark,
  'google-sheets': GoogleSheetsMark,
  sentry: SentryMark,
  vercel: VercelMark,
  // Model providers and open-weight families the runtime can be pointed at.
  openai: OpenAiMark,
  anthropic: AnthropicMark,
  'google-gemini': GoogleGeminiMark,
  openrouter: OpenRouterMark,
  deepseek: DeepSeekMark,
  qwen: QwenMark,
  moonshot: MoonshotAiMark,
  zai: ZaiMark,
  minimax: MiniMaxMark,
} as const satisfies Record<string, ComponentType<CustomIconProps>>;

export type BrandAssetId = keyof typeof BRAND_ASSETS;

export function resolveBrandAsset(assetId: string): ComponentType<CustomIconProps> | undefined {
  return (BRAND_ASSETS as Record<string, ComponentType<CustomIconProps> | undefined>)[assetId];
}
