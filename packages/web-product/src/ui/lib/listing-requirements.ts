import type { IconName } from '@aflow/design-system';
import type { ListingRequirements } from '@aflow/schemas';

export interface ListingRequirementRow {
  icon: IconName;
  label: string;
}

function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, ' ');
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Plain-language "what you'll need" rows for a store listing's requirements. */
export function listingRequirementRows(requirements: ListingRequirements): ListingRequirementRow[] {
  const rows: ListingRequirementRow[] = [];
  for (const key of requirements.credentialKeys) {
    rows.push({ icon: 'key', label: `Paste your ${humanizeKey(key)}` });
  }
  for (const issuer of requirements.oauthIssuers) {
    rows.push({ icon: 'plugs', label: `Connect your ${titleCase(issuer)} account` });
  }
  if (requirements.needsRepo) {
    rows.push({ icon: 'git-branch', label: 'Choose a repository' });
  }
  if (requirements.needsModelKey) {
    rows.push({ icon: 'key', label: 'Add an AI provider key' });
  }
  return rows;
}
