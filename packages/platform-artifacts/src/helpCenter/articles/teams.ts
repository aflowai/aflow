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

Organisation-wide membership and invitations are under **Tenant Admin** at the foot of the sidebar, on the **Members** and **Invites** tabs, for tenant admins.`,
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
      'Aflow Local has no invitations and no members. People who share one install each get a profile, which the owner adds and manages under Settings → Profiles. Each profile has its own spaces, conversations and memory, and model keys stored for the whole install are shared. Once an install has two profiles, each browser opens on Who is using Aflow? and the person picks their profile. To switch, open the menu under your avatar at the foot of the sidebar. The owner can lock a profile with a PIN of four to six digits, and the picker then asks for it. A browser that has not picked a profile skips the picker on an install with one profile and no PIN.',
    body: `**Where:** **Settings** → **Profiles** (the owner only), and the menu under your avatar at the foot of the sidebar

## What a profile is

Each person who shares this install has a profile with a name and an avatar. A profile has its own spaces, conversations and memory. Model keys stored for the whole install are shared by every profile.

## Adding a profile

1. Press **Add profile**.
2. Enter a **Name** and choose an **Avatar**.
3. Press **Add profile**.

The new profile starts with a space of its own called Personal, and it does not see your spaces. Once the install has two profiles, this browser asks who is using Aflow too. Pick your own profile to carry on.

## Who is using Aflow?

An install with two or more profiles opens on **Who is using Aflow?** in a browser that has not picked a profile yet. It shows each profile's avatar and name. Pick yours, and Aflow opens in the space that profile last used. The browser remembers the choice until someone switches profile or the browser's cookies are cleared. An install with one profile and no PIN skips this screen for a browser that has not picked a profile. A browser that picked a profile which has since been removed sees this screen once more, even when one profile is left.

A profile with a PIN shows **PIN** under its name. Pick it, enter its PIN and press **Continue**. A wrong PIN opens nothing, and after several wrong tries the profile makes you wait before the next one. An install whose only profile has a PIN asks for it in every browser that has not entered it yet.

## Locking a profile with a PIN

The owner sets each profile's PIN in **Settings** → **Profiles**.

1. Press **Set PIN** on the profile, or **Change PIN** where it has one.
2. Enter four to six digits, and enter them again.
3. Press **Set PIN** or **Change PIN**.

Every browser using that profile goes back to the picker, yours included when it is your own profile. Choose the profile there and enter the new PIN. Aflow stores the PIN as a one-way hash, never the digits themselves.

A PIN keeps people at this browser out of each other's profiles. It does not protect a profile from anyone who can sign in to this computer's account, because that person can read the install's own files.

## A forgotten PIN

The owner presses **Reset PIN** on the profile and confirms. The profile has no PIN afterwards, and every browser using it goes back to the picker. Set a new PIN if the profile should stay locked. Only the owner sets or resets a PIN.

Nobody above the owner can reset the owner's own PIN, so keep it somewhere safe. A request that carries the install's instance secret, from \`instance.env\`, still acts as the owner and can reset it with \`DELETE /v1/local-profiles/<profile id>/pin\`.

## Switching profile

Open the menu under your avatar at the foot of the sidebar. It names the profile using Aflow now and lists the other profiles. Pick one to switch to it, or press **Switch profile** to open the picker. The owner also finds **Manage profiles** there, which opens **Settings** → **Profiles**.

## Editing a profile

Press **Edit** on a profile, change its **Name** or choose another **Avatar**, and press **Save**.

## Removing a profile

1. Press **Remove** on the profile. The owner's own profile has no **Remove**.
2. The dialog lists the spaces only that profile is in. They are deleted with everything in them.
3. Spaces it shares with others pass to you.
4. Press **Remove profile**. Its sessions end, and this cannot be undone. A browser that was using it goes back to the picker.`,
    editions: ['community-local'],
    anchors: { routes: ['settings/profiles'], operations: [] },
    related: ['local-edition-limits', 'api-keys'],
    keywords: [
      'profile',
      'profiles',
      'share',
      'family',
      'avatar',
      'rename',
      'remove',
      'people',
      'choose',
      'login',
      'pin',
      'lock',
      'forgot pin',
      'reset pin',
    ],
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
