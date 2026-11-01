import type { HelpArticleInput } from '@aflow/schemas';
import { APPROVALS_ARTICLES } from './approvals.js';
import { AUTOMATION_ARTICLES } from './automation.js';
import { CHANNELS_ARTICLES } from './channels.js';
import { CONCEPTS_ARTICLES } from './concepts.js';
import { GETTING_STARTED_ARTICLES } from './getting-started.js';
import { INTEGRATIONS_ARTICLES } from './integrations.js';
import { MODELS_ARTICLES } from './models.js';
import { PRIVACY_ARTICLES } from './privacy.js';
import { SKILLS_ARTICLES } from './skills.js';
import { TEAMS_ARTICLES } from './teams.js';
import { THIS_COMPUTER_ARTICLES } from './this-computer.js';
import { TROUBLESHOOTING_ARTICLES } from './troubleshooting.js';

export const HELP_ARTICLE_SOURCES: readonly HelpArticleInput[] = [
  ...GETTING_STARTED_ARTICLES,
  ...MODELS_ARTICLES,
  ...PRIVACY_ARTICLES,
  ...CONCEPTS_ARTICLES,
  ...SKILLS_ARTICLES,
  ...APPROVALS_ARTICLES,
  ...INTEGRATIONS_ARTICLES,
  ...CHANNELS_ARTICLES,
  ...THIS_COMPUTER_ARTICLES,
  ...AUTOMATION_ARTICLES,
  ...TEAMS_ARTICLES,
  ...TROUBLESHOOTING_ARTICLES,
];
