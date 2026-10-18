import type { HelpTheme } from '@aflow/schemas';

/** Shelf order and labels for the help page; every theme has one. */
export const HELP_THEME_LABELS: Readonly<Record<HelpTheme, string>> = {
  'getting-started': 'Getting started',
  models: 'Models and keys',
  privacy: 'Privacy',
  concepts: 'Concepts',
  skills: 'Skills',
  approvals: 'Approvals',
  integrations: 'Integrations',
  'this-computer': 'This Computer',
  automation: 'Automation',
  teams: 'Teams',
  troubleshooting: 'Troubleshooting',
};

export const HELP_THEME_ORDER = Object.keys(HELP_THEME_LABELS) as readonly HelpTheme[];
