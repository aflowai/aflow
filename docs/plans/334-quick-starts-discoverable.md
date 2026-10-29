# Plan 334 — A new user finds the quick starts

**Status:** 🚧 in progress. P0 (this design), P1 (the templates beside the blank start) and P2 (the first-run card) are built. P3 (the live check) remains.

**Builds on:** Plan 330 (a quick start is a Store entry of kind `space`, installed by `POST /v1/store/space-installs` into a space it creates), Plan 315 (the local edition's first run), Plan 325 (help articles).

**Leaves alone:** the quick starts themselves, their install path, the Store's **Quick starts** tab and the listing page's **Start a new space from it**, and the provider setup wizard.

## 1. Problem

The Store ships ready-made spaces, for example Coding with GitHub. A new user does not find them:

- **First run.** A fresh install does not reliably tell the user that ready-made spaces exist.
- **New space.** The flow that makes a space starts blank. A template is not offered beside the blank start. This applies to every user at every time, not only at first run. A user with ten spaces who makes an eleventh must also see the templates. If not, the quick starts are reachable only through the Store.

The operator's constraints: keep it smooth and small. Each moment gets one well-placed offer that the user can dismiss. No onboarding wizard. No notifications. The offer is gone once used.

## 2. What the code shows today

Read at `138bdedc`. Plan 330 P1 (#205) built more than the problem statement assumes. This design uses it rather than adding beside it.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | **A first-run offer exists, as a modal.** `QuickStartOffer` (`quick-start-offer.tsx` in `web-product`, removed by P2) is mounted only by `apps/web-local/src/app/(dashboard)/layout.tsx`. It opens a `Dialog` titled "Start from a quick start" over whatever page loads. It shows `QuickStartPicker` with a "Keep {space}" card beside each template.                                                                                                                                                                                                 |
| F2  | **The server already decides when the first-run offer applies, and that rule ends it for good.** `GET /v1/store/quick-start-offer` (`packages/server-runtime/src/routes/storeSpaceTemplates.ts`) returns `applies: true` only while the tenant's one live space is its default space and `spaceHoldsNothing` is true: no store install, session, agent, API or MCP definition, connected folder, or hand-written skill. The first conversation or the first installed quick start turns it off.                                                        |
| F3  | **Dismissal already lives in the browser.** A decline writes `localStorage['aflow:quick-start-offer-declined'] = '1'`. A created space writes it too. No server-side store exists for UI preferences, and there is no other dismissal mechanism in `web-product` (`provider-setup-deferral.ts` uses `sessionStorage` for one navigation only).                                                                                                                                                                                                         |
| F4  | **The modal sits behind the provider wizard and is easy to lose.** `QuickStartOffer` renders as a child of `DashboardShell` → `SpaceGate`. On a fresh local install no provider is configured, so `SpaceGate` renders `OnboardingFlow` (resumed: name → model → connect → ready) in place of its children. The offer mounts only after the wizard. Then the `Dialog` treats Escape, the backdrop and the close button as `onClose`, and that is wired to the permanent decline. One stray click hides the quick starts in that browser for good.       |
| F5  | **The one screen every fresh install passes does not mention spaces.** The wizard's Ready step (`onboarding-flow.tsx`, `StepReady`) has a **Browse the Store** card that reads "Install ready-made skills and connectors for common work."                                                                                                                                                                                                                                                                                                             |
| F6  | **A fresh install lands in the empty chat.** The front door (`apps/web-local/src/app/page.tsx`) enters `/chat` in the preferred space, and the wizard ends at `/s/{slug}/chat`. With no conversation, `space-chat.tsx` shows the Helmsman orb and its greeting ("This is Helmsman, your workflow assistant — …"), gated on `greetingReady` (Helmsman flow, `emptyChat`). This is the space's empty state. No other first-run surface exists: the Workbench first-run checklist from Plan 315 P3 has not been built (`components/workbench/` has none). |
| F7  | **The new-space flow is blank-only. The quick start is a sibling menu item.** The space selector popover (`space-selector.tsx`) has **Create new workspace**, which opens `CreateSpaceDialog`: `CreateSpaceForm` (name, description, responsibility) → `ReadinessGate`. Beside it, **Start from a quick start** opens a separate `QuickStartDialog`. That item is shown only when `templates.length > 0`. A user who chooses "create" never sees a template.                                                                                           |
| F8  | **The picker already knows how to put a "start without a template" card first.** `QuickStartPicker` takes `emptySpace` and `onKeepEmptySpace` and renders that card ahead of the template cards. It also renders the name field and creates the space with slug retries.                                                                                                                                                                                                                                                                               |
| F9  | **Where templates are not on the shelf, the offer data is empty.** `shelvedTemplates` filters by the edition's lanes and the tenant shelf (`isListingOnTenantShelf`). Both templates need the host lane, so the hosted edition lists none today, and every quick-start surface hides itself on `templates.length === 0`.                                                                                                                                                                                                                               |
| F10 | **The help article describes the current surfaces by name.** `helpCenter/articles/concepts.ts` names **Create new workspace**, **Start from a quick start**, **Create the space**, and the first-run offer "beside it when you open Aflow". Any change here must update it in the same phase.                                                                                                                                                                                                                                                          |
| F11 | **The vocabulary is mixed.** The selector and the create dialog say "workspace". The picker and the Store say "space" ("Name the new space", "Create the space", "Start a new space from it"). The help article says "A space (called a workspace on some screens)".                                                                                                                                                                                                                                                                                   |

This round did not reproduce the operator's observation, "a fresh install shows nothing", on a live stack, because it changes documentation only. F4 and F5 explain the observation, and the design below does not depend on the exact cause: it moves the offer to the surface that every fresh install reaches and that one stray click cannot lose.

## 3. Decisions

### D1 — First run: one inline card in the empty chat of the empty first space

**Surface.** A card under the Helmsman greeting, in the `chat-enter-center` block of `space-chat.tsx` (F6). It renders only when all of the following are true:

- the offer applies (`useQuickStartOffer().data.applies`, F2);
- the active space is `emptySpace.id`;
- the chat is empty (`greetingReady`);
- this browser has not declined it (F3).

The `QuickStartOffer` modal and its mount in the `web-local` layout are removed. There is one offer, not two.

Why this place:

- Every fresh install reaches it, with or without the wizard (F6).
- It is the space's empty state, which is the moment the operator described.
- It sits in the page, so it does not cover the page.
- It goes away by itself when the user starts working, because the first conversation makes `emptyChat` false and `applies` false (F2).
- It lives in `web-product`, gated only on data. The hosted edition gets it with no second copy when templates are on its shelf (F9). Today they are not, so hosted shows nothing.

**Copy.**

- Title: **Start from a ready-made workspace**
- Body: **Quick starts in the Store make a new workspace with the skills and Helmsman directives for one kind of work already installed — {template names, joined with "and"}. {emptySpace.name} stays as it is.**
  Rendered today: "… already installed — Code Review on This Computer and Coding with GitHub. Personal stays as it is."
- Primary button: **Browse quick starts**. It goes to `/s/{slug}/store?kind=quick-start`, the Store's **Quick starts** tab. The user learns where quick starts live, reads each listing's description and readiness, and starts one with the listing's existing **Start a new space from it**.
- Secondary button: **Not now**

**Dismissal and "gone once used".**

- **Dismissed:** only **Not now** writes the existing key, `localStorage['aflow:quick-start-offer-declined'] = '1'`. Reusing the key means a browser that declined the old modal is not asked again. The card has no close icon and is not modal, so there is no Escape or backdrop path to a decline.
- **Used, gone for good:** the server rule F2 decides this, unchanged. Installing a quick start makes a second live space, and `applies` is false from then on. Starting to work blank (a conversation, an install, a connected folder) also makes it false. Nothing writes the key on creation, because the first-run path no longer embeds the picker. The first conversation or the first installed quick start turns the offer off through F2 alone.
- **Where state lives:** in the server predicate (derived, nothing stored) plus one browser key. No new table, column or endpoint.

Clicking **Browse quick starts** is not a dismissal. A user who looks and comes back with nothing installed still sees the card in the empty chat until they choose **Not now** or start working.

### D2 — New space: templates beside the blank start, inside "Create new workspace"

**Surface.** `CreateSpaceDialog` gets a first view that is a choice. It reuses `QuickStartPicker` (F8): the leading card is **Blank workspace**, followed by one card per template (name and tagline from the catalog, as today).

- Choosing **Blank workspace** shows the existing `CreateSpaceForm` → `ReadinessGate`, unchanged, with a **Back** link to the choice.
- Choosing a template shows the picker's existing name field and create button. The install navigates to the new space's chat, as it does today.
- With no template on the shelf (F9: hosted today, or a tenant that hid them), the dialog opens on the blank form exactly as it does today, with no empty chooser.

The separate **Start from a quick start** item leaves the space selector. **Create new workspace** is the one way to make a space, and it always shows the templates. The Store listing's **Start a new space from it** keeps `QuickStartDialog` with `initialCatalogId`. That is the Store's own surface, not the new-space flow.

Why this place: the space selector's **Create new workspace** is the only blank-start entry in the product. `CreateSpaceForm`'s other caller is the hosted zero-space wizard, and `/spaces` has no create action. So the choice placed here is the one every user meets every time they make a space.

**Copy.**

- Dialog title (unchanged): **Create new workspace**
- Lede above the cards: **Start blank, or from a quick start that comes with the skills and directives for one kind of work.**
- Leading card: **Blank workspace** — **Name it and set it up yourself.**
- Template cards: the catalog's `name` and `tagline`, unchanged.
- After a template is chosen: the label **Name the new workspace** (was "Name the new space") and the button **Create workspace** (was "Create the space"). The same button now reads the same for both starts. This is the only vocabulary change (F11), limited to the strings this dialog shows. The Store keeps "space".
- Back link on the blank form: **Back**

**Dismissal and "gone once used".** None, on purpose. This is not an interruption. It is the content of a dialog the user opened. Choosing **Blank workspace** is the decline for that one visit, and nothing is remembered. Because the templates must stay visible to any user at any time, nothing here is ever "used up". The only rule is the shelf: no template on the shelf means no chooser. No state is stored anywhere.

### D3 — Not built, on purpose

- **No onboarding wizard.** No step is added to `OnboardingFlow`, and no new multi-step flow is created.
- **No notification spam.** No toast, no Action Center item, no Workbench entry, no badge on the Store in the rail, no email, and no Helmsman message.
- **No surfaces beyond the two.** D1 removes the existing modal and D2 removes the separate selector item, so the count goes down.

Considered and rejected:

| Option                                                                                           | Why not                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the `QuickStartOffer` modal and only fix its gating                                         | It covers whatever page loads, it opens behind the wizard (F4), and every way of closing it is a permanent decline. An inline card in the empty state does the same job without interrupting.            |
| A quick-start card on the wizard's Ready step (F5), or a change to its **Browse the Store** copy | It grows the wizard. It shows only when no provider is configured, so a user with keys in `.env` never sees it. It would also be a second first-run surface beside D1.                                   |
| A line in the Helmsman greeting, or a directive telling Helmsman to suggest quick starts         | Prose in a prompt is the last resort (CLAUDE.md). It cannot be dismissed, and it turns the assistant into an advert.                                                                                     |
| A Workbench first-run checklist item                                                             | No checklist exists (F6). Building Plan 315 P3 to hold one offer is out of proportion.                                                                                                                   |
| Server-side dismissal (a user-preferences column)                                                | Nothing stores UI preferences today (F3). The local edition has one operator, and the server predicate already ends the offer for good once it is used. A migration for one boolean is over-engineering. |
| Keeping **Start from a quick start** in the selector beside the new chooser                      | Two entries that do the same thing. The help article would have to explain both.                                                                                                                         |
| Marking templates a user has already used ("you have a space from this")                         | Making a second space from a template is legitimate (Plan 330 D1). The mark adds a read for no decision.                                                                                                 |
| Applying a template to the current space from the chooser                                        | Refused by Plan 330 D1. A template writes directives and always makes a new space.                                                                                                                       |
| A quick-start step in the hosted zero-space wizard (`OnboardingFlow` without `resumeFor`)        | Hosted lists no templates today (F9), and that wizard is Plan 227's. Revisit when a template composes there.                                                                                             |

## 4. What it affects

- `packages/web-product`:
  - `space-chat.tsx`: the D1 card;
  - `create-space-dialog.tsx`: the D2 chooser;
  - `quick-start-picker.tsx`: the leading card generalised from `emptySpace` to a caller-supplied card, and the two strings;
  - `space-selector.tsx`: the item removed;
  - `quick-start-offer.tsx`: removed, together with its export in `ui/index.ts`.
- `apps/web-local/src/app/(dashboard)/layout.tsx`: the `QuickStartOffer` mount removed.
- `packages/platform-artifacts/src/helpCenter/articles/concepts.ts`: the "Starting from a quick start" section and the selector paragraph (F10).
- No schema, route, migration or stored data changes. `GET /v1/store/quick-start-offer` is read as it is.

## 5. How it is proven

- **The card's condition is one pure function** (`shouldOfferQuickStarts({ offer, activeSpaceId, emptyChat, declined })`), with a unit test for each way the card must not show: offer not applying, another space active, a conversation open, declined, no templates.
- **The chooser test** renders `CreateSpaceDialog` with two templates and asserts that **Blank workspace** comes first and the templates follow. It renders it again with none and asserts that the blank form opens directly. If someone later moves the templates back behind a separate entry, this test fails.
- **The live check** (P3) on a fresh local install:
  - finish the wizard;
  - the card shows in the empty chat;
  - **Not now** hides it, and it stays hidden after a reload;
  - in a second browser profile, **Browse quick starts** → **Start a new space from it** makes the space, and the card is gone in both;
  - **Create new workspace** in that state still lists both templates.

## 6. Phases — proposed, pending operator approval

**P0 — This document.** _Exit:_ the operator approves or amends §3. Its row in `docs/plans/README.md` lands with P1, because this round changes one file only.

**P1 — Templates beside the blank start (D2).** The chooser in `CreateSpaceDialog`, the picker's leading card generalised, the selector item removed, the help article's selector paragraph updated, and the chooser test. _Exit:_ **Create new workspace** shows **Blank workspace** first, followed by every shelved template. With none on the shelf it opens on the blank form. **Start from a quick start** appears nowhere.

**P2 — The first-run card (D1).** The card in the empty chat with its pure condition and test, the modal and its `web-local` mount removed, and the help article's first-run paragraph updated. _Exit:_ the unit cases in §5 pass, and no page mounts `QuickStartOffer`.

**P3 — Live check.** §5's live check on a fresh install. It also closes Plan 330 P1's open live exit, whose first-run half then reads the card instead of the modal. _Exit:_ each step in §5 is observed as written.
