import type { HelpArticleInput } from '@aflow/schemas';

export const TEAMS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'invite-members',
    theme: 'teams',
    question: 'How do I share a space with a teammate?',
    summary:
      'A space admin opens People in the sidebar, or Settings → Members, and presses Share space. Enter the teammate’s email and a space role — Viewer, Editor or Admin — and press Share. They see the space’s sessions, memory and artifacts. Someone who is not a member yet is listed under Pending shares and joins the first time they sign in with that email. Admins can change a member’s role, remove a member, or revoke a pending share.',
    body: `**Where:** **People** in the sidebar, or **Settings → Members** (space admins)

## Share the space

1. Press **Share space**.
2. Enter the teammate's **Email**.
3. Choose a **Space role**: **Viewer**, **Editor** or **Admin**. Viewer is preselected.
4. Press **Share**.

They see this space's sessions, memory and artifacts.

## Someone who has not signed in yet

If they are not a member here yet, the share is listed under **Pending shares** with its role and the date it was made, and access is granted the first time they sign in with that email. **Revoke** withdraws a pending share before it is used.

## Managing members

The members table lists each person's email, role and the date they were added. A space admin can:

- change a member's role with the **Role** selector;
- **Remove** a member from the space, after confirming.

Members who are not admins see the list without these controls.

## Across the organisation

Organisation-wide membership and invitations are under **Tenant Admin** at the foot of the sidebar, on the **Members** and **Invites** tabs, for tenant admins.

## In Aflow Local

Aflow Local has no invitations, no People entry and no Members tab. Several people share it as profiles instead, which its owner adds under **Settings** → **Profiles**. Each profile starts with a space of its own and does not see the others' spaces.`,
    editions: ['enterprise'],
    anchors: { routes: ['s/[space]/settings/members'], operations: [] },
    related: ['what-is-a-space', 'api-keys', 'local-edition-limits'],
    keywords: ['invite', 'members', 'people', 'role', 'viewer', 'editor', 'admin', 'collaborate'],
  },
  {
    id: 'local-profiles',
    theme: 'teams',
    question: 'How do several people share Aflow Local?',
    summary:
      'Aflow Local has no invitations and no members. People who share one install each get a profile, which the owner manages under Settings → Profiles. Each profile has its own spaces, conversations and memory, and model keys stored for the whole install are shared. The owner can rename a profile, change its avatar or remove it. Adding a profile waits for the profile picker, because a second profile would stop every browser from opening Aflow until a browser can choose a profile.',
    body: `**Where:** **Settings** → **Profiles** (the owner only)

## What a profile is

Each person who shares this install has a profile with a name and an avatar. A profile has its own spaces, conversations and memory. Model keys stored for the whole install are shared by every profile.

## Editing a profile

Press **Edit** on a profile, change its **Name** or choose another **Avatar**, and press **Save**.

## Removing a profile

1. Press **Remove** on the profile. The owner's own profile has no **Remove**.
2. The dialog lists the spaces only that profile is in. They are deleted with everything in them.
3. Spaces it shares with others pass to you.
4. Press **Remove profile**. Its sessions end, and this cannot be undone.

## Adding a profile

**Add profile** is off in this version. Once a second profile exists, every browser must choose a profile before it opens Aflow, the owner's included. This version has no profile picker, so no browser could open Aflow again and this page could not remove the profile. **Add profile** turns on when the picker arrives.`,
    editions: ['community-local'],
    anchors: { routes: ['settings/profiles'], operations: [] },
    related: ['local-edition-limits', 'api-keys'],
    keywords: ['profile', 'profiles', 'share', 'family', 'avatar', 'rename', 'remove', 'people'],
  },
  {
    id: 'api-keys',
    theme: 'teams',
    question: 'How do I create an API key to call Aflow from a script or another tool?',
    summary:
      'Open Tenant Admin at the foot of the sidebar and the API Keys tab, then press Create API Key. Give it a name, choose an expiration or none, and press Create. The full key is shown once, in the API Key Created dialog — copy it then. It authenticates as you within this tenant, sent as a bearer token in the Authorization header. Revoke ends a key permanently.',
    body: `**Where:** **Tenant Admin** at the foot of the sidebar → **API Keys** (the page is titled **Settings** in Aflow Local)

## Create a key

1. Press **Create API Key**.
2. Give it a **Name** that says what uses it, such as a CI pipeline or local development.
3. Choose an **Expiration**: 7, 30, 90, 180 or 365 days, or **No expiration**.
4. Press **Create**.

The **API Key Created** dialog shows the full key once. Copy it before pressing **Done** — it cannot be shown again.

## Using it

The key authenticates as you within this tenant, so whatever it calls runs with your access. Send it as a bearer token:

\`\`\`
Authorization: Bearer <your key>
\`\`\`

In Aflow Local, a client of the Aflow MCP endpoint authenticates with a key made here, the same way. Keep keys secret, and give each tool its own so one can be revoked without the others.

## Seeing and revoking keys

The list shows each active key's name, the start of the key, when it was created, when it was last used, and when it expires. **Revoke** ends a key after you confirm; this cannot be undone. Revoked keys stay listed under **Revoked Keys** with the date they were revoked.

## Who can do this

The page is shown to admins. Anyone else opening it is taken to their account page.`,
    editions: ['enterprise', 'community-local'],
    anchors: { routes: ['settings/api-keys'], operations: [] },
    related: ['where-credentials-live', 'invite-members'],
    keywords: ['token', 'bearer', 'authentication', 'script', 'ci', 'revoke', 'mcp client'],
  },
];
