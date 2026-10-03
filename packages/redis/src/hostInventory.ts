/**
 * What the appliance and a paired machine say to each other through Redis.
 *
 * Two sides in two apps that must agree on the key a machine publishes under,
 * the set it announces itself into, how long silence means gone, and the
 * channel a withdrawal travels on. Spelled out separately they drifted — the
 * reader looked for members the writer no longer added.
 */
import { z } from 'zod';

import {
  BrowserProfileIdSchema,
  BrowserProfileSchema,
  type HostPublishedChecks,
  HostPublishedChecksSchema,
  type HostPushApproval,
  HostPushApprovalSchema,
} from '@aflow/schemas';

/** Per-machine inventory, written with a lifetime so silence expires. */
export function hostInventoryKey(hostname: string): string {
  return `aflow:host-inventory:${hostname}`;
}

/**
 * The machines themselves, scored by when each was last heard from.
 *
 * A set of names would only shrink on a clean shutdown, and the default machine
 * name carries the executor's pid — so every crash left one more name behind
 * and listing machines grew with the history rather than the fleet.
 */
export const HOST_MACHINES_KEY = 'aflow:host-machines';

/** How long an inventory stands before the machine counts as gone. */
export const HOST_INVENTORY_TTL_SECONDS = 120;
export const HOST_INVENTORY_TTL_MS = HOST_INVENTORY_TTL_SECONDS * 1000;

/**
 * Republished at half its lifetime, so one missed cycle is not a death and the
 * declared invariant — "written with a lifetime twice its refresh" — is a fact
 * about this line rather than a description that drifted away from it.
 */
export const HOST_INVENTORY_REFRESH_MS = (HOST_INVENTORY_TTL_SECONDS / 2) * 1000;

/**
 * A binding withdrawn on the appliance, announced to the machine holding it.
 *
 * Deleting the row stops the next step from being scheduled, which is the whole
 * of what the appliance can enforce by itself. It says nothing to a command
 * already running: a detached process exists precisely so the step that started
 * it can end, so nothing was going to ask again, and the folder stayed reachable
 * for as long as that process lived — while the workspace showed it
 * disconnected.
 *
 * Only ever narrowing. The machine's policy file remains the authority on what
 * may start; this can end work already under way and nothing else, which is why
 * acting on it needs no trust in the sender.
 */
export const HOST_WITHDRAWAL_CHANNEL = 'aflow:pubsub:host-withdrawal';

export interface HostWithdrawalNotice {
  readonly spaceId: string;
  readonly hostBindingId: string;
}

/**
 * The operator asking, from the workspace, for a profile's window to sign in:
 * the same sitting `aflow browser sign-in` holds on the machine. Published only
 * by the authenticated operator route — no operation dispatches it, so no agent
 * can — and acted on only by the executor of the machine it names.
 *
 * One channel per machine, named as its inventory is, so the count of
 * receivers a publish returns is whether that machine's executor heard it.
 * On a channel every executor shared, another machine being up answered for a
 * target that was down, and the operator was told a window was coming.
 */
export function hostBrowserSignInChannel(hostname: string): string {
  return `aflow:pubsub:host-browser-sign-in:${hostname}`;
}

export const HostBrowserSignInRequestSchema = z.object({
  hostname: z.string().min(1),
  profileId: BrowserProfileIdSchema,
});
export type HostBrowserSignInRequest = z.infer<typeof HostBrowserSignInRequestSchema>;

/** The profile a sign-in request asks for, when it is well formed and names `hostname`. */
export function readHostBrowserSignInRequest(raw: string, hostname: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const request = HostBrowserSignInRequestSchema.safeParse(parsed);
  if (!request.success || request.data.hostname !== hostname) return undefined;
  return request.data.profileId;
}

/**
 * What a machine publishes about itself.
 *
 * Both halves are observed rather than declared: the runtimes by probing the
 * machine, the harnesses from the machine's own policy file — the same map
 * `host.harness.run` resolves an id against, so a name here is one the run can
 * actually address. An id and the name an operator would recognise, nothing
 * more: what an id runs is the machine's business, and naming an executable in
 * shared state would make it look addressable.
 */
export const HostInventorySchema = z.object({
  hostname: z.string(),
  observedAt: z.string(),
  runtimes: z.array(z.object({ name: z.string(), version: z.string() })),
  harnesses: z.array(z.object({ id: z.string(), label: z.string().optional() })),
  /**
   * How many of those run at once on this machine; a run past it waits for one
   * to end.
   */
  maxConcurrentHarnessRuns: z.number().int().min(1),
  /**
   * The push posture of each folder this machine lets push, and whether a
   * publication from it runs checks and which program, from the same policy
   * file. Published rather than
   * recorded by the workspace because the operator changes both on the
   * machine, where the workspace never hears of it.
   *
   * Keyed by workspace as well as id: an id is unique on one machine, and two
   * machines can each offer the same one to different workspaces.
   */
  folders: z.array(
    z.object({
      id: z.string(),
      spaceId: z.string(),
      pushApproval: HostPushApprovalSchema,
      checks: HostPublishedChecksSchema.optional(),
    }),
  ),
  /**
   * The browser profiles this machine offers, from its policy file, and
   * whether each one's browser is running now. Sites are the hosts a running
   * profile holds cookies for, by name: never a value, and absent while the
   * browser is stopped, because only a running browser can be asked.
   * `windowOpen` is the operator holding the profile's window — a sign-in
   * sitting or a hand-off — during which runs on it are refused.
   */
  browsers: z.array(
    BrowserProfileSchema.pick({
      id: true,
      posture: true,
      window: true,
      spaces: true,
      rules: true,
      idleMinutes: true,
    }).extend({
      running: z.boolean(),
      windowOpen: z.boolean(),
      sites: z.array(z.string()).optional(),
    }),
  ),
});
export type HostInventory = z.infer<typeof HostInventorySchema>;
export type HostInventoryFolders = HostInventory['folders'];
export type HostInventoryBrowsers = HostInventory['browsers'];

/** What the machine holding a pushing folder declares about publishing from it. */
export interface PublishingFolder {
  readonly pushApproval: HostPushApproval;
  readonly checks?: HostPublishedChecks;
}

/**
 * Each pushing folder's posture and checks, as the machines publishing now
 * declare them, for one workspace. A folder missing here pushes nothing, or its
 * machine is not running — the two read the same to a caller, which then says
 * nothing.
 */
export function publishingFoldersForSpace(
  inventories: ReadonlyArray<Pick<HostInventory, 'folders'>>,
  spaceId: string,
): Map<string, PublishingFolder> {
  const folders = new Map<string, PublishingFolder>();
  for (const machine of inventories) {
    for (const folder of machine.folders) {
      if (folder.spaceId === spaceId && !folders.has(folder.id)) {
        folders.set(folder.id, {
          pushApproval: folder.pushApproval,
          ...(folder.checks !== undefined ? { checks: folder.checks } : {}),
        });
      }
    }
  }
  return folders;
}

/** The reads this needs, so a caller can hand it any client or a fake. */
interface HostInventoryReader {
  zrangebyscore(key: string, min: number, max: string): Promise<string[]>;
  get(key: string): Promise<string | null>;
}

/**
 * The inventories of every machine heard from inside the TTL.
 *
 * Scored membership plus one read per live machine: finding these by walking
 * the keyspace is what [[180]] forbids, and the cost follows the fleet rather
 * than everything stored. Nothing is pruned here — a reader that deletes makes
 * every caller a writer — so an aged-out member is skipped rather than removed.
 */
export async function readLiveHostInventories(
  redis: HostInventoryReader,
  now: number = Date.now(),
): Promise<HostInventory[]> {
  const names = await redis.zrangebyscore(HOST_MACHINES_KEY, now - HOST_INVENTORY_TTL_MS, '+inf');
  const inventories: HostInventory[] = [];
  for (const name of names) {
    const raw = await redis.get(hostInventoryKey(name));
    // A name whose inventory expired is a machine that stopped publishing; a
    // machine writing something unreadable is not a reason to drop the rest.
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const inventory = HostInventorySchema.safeParse(parsed);
    if (inventory.success) inventories.push(inventory.data);
  }
  return inventories;
}
