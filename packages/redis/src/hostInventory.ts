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
  BrowserLocalPortSchema,
  BrowserProfileIdSchema,
  BrowserProfileSchema,
  HostFolderPreviewSchema,
  type HostPublishedChecks,
  HOST_MERGE_POSTURE_DEFAULT,
  type HostMergePosture,
  HostMergePostureSchema,
  HostPublishedChecksSchema,
  type HostPushApproval,
  HostPushApprovalSchema,
  HostSandboxPostureSchema,
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
 * The operator asking, from the workspace, for what `aflow browser` does on
 * the machine: a profile's window to sign in, or a change to its posture,
 * `unattended` choice, origin rules or the loopback ports it is opened to. Published only by the operator routes,
 * which take a person's authenticated request — no operation dispatches it, so
 * no agent can — and acted on only by the executor of the machine it names.
 *
 * One channel per machine, named as its inventory is, so the count of
 * receivers a publish returns is whether that machine's executor heard it.
 * On a channel every executor shared, another machine being up answered for a
 * target that was down, and the operator was told a window was coming.
 */
export function hostBrowserRequestChannel(hostname: string): string {
  return `aflow:pubsub:host-browser:${hostname}`;
}

/**
 * Where the executor answers one setting change, named by the request. The
 * values are strings as the command takes them: the executor validates them
 * with the command's own writer, and its refusal is the answer.
 */
export function hostBrowserAnswerChannel(answerId: string): string {
  return `aflow:pubsub:host-browser-answer:${answerId}`;
}

/**
 * The operator asking, from the workspace, for the model runtime on this
 * machine to start (Plan 323 D15). Published only by the operator's
 * local-models route on a space admin's request, and acted on only by the
 * executor of the machine it names, which starts the one program it knows
 * and nothing the request could name.
 */
export function hostRuntimeRequestChannel(hostname: string): string {
  return `aflow:pubsub:host-runtime:${hostname}`;
}

export function hostRuntimeAnswerChannel(answerId: string): string {
  return `aflow:pubsub:host-runtime-answer:${answerId}`;
}

export const HostRuntimeRequestSchema = z.object({
  kind: z.literal('start'),
  hostname: z.string().min(1),
  answerId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  /** The loopback port the space's connection names, which the runtime is waited for on. */
  port: z.number().int().min(1).max(65_535),
});
export type HostRuntimeRequest = z.infer<typeof HostRuntimeRequestSchema>;

export const HostRuntimeAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), message: z.string() }),
  z.object({ kind: z.literal('refused'), message: z.string() }),
]);
export type HostRuntimeAnswer = z.infer<typeof HostRuntimeAnswerSchema>;

/** The request, when it is well formed and names `hostname`. */
export function readHostRuntimeRequest(
  raw: string,
  hostname: string,
): HostRuntimeRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const request = HostRuntimeRequestSchema.safeParse(parsed);
  if (!request.success || request.data.hostname !== hostname) return undefined;
  return request.data;
}

const SettingWordSchema = z.string().max(2048);

export const HostBrowserSettingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('posture'), posture: SettingWordSchema }),
  z.object({ kind: z.literal('unattended'), choice: SettingWordSchema }),
  z.object({ kind: z.literal('rule'), origin: SettingWordSchema, effect: SettingWordSchema }),
  z.object({ kind: z.literal('rule_remove'), origin: SettingWordSchema }),
  z.object({ kind: z.literal('local_port'), port: SettingWordSchema }),
  z.object({ kind: z.literal('local_port_remove'), port: SettingWordSchema }),
]);
export type HostBrowserSetting = z.infer<typeof HostBrowserSettingSchema>;

export const HostBrowserRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sign_in'),
    hostname: z.string().min(1),
    profileId: BrowserProfileIdSchema,
  }),
  z.object({
    kind: z.literal('setting'),
    hostname: z.string().min(1),
    profileId: BrowserProfileIdSchema,
    answerId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    setting: HostBrowserSettingSchema,
  }),
]);
export type HostBrowserRequest = z.infer<typeof HostBrowserRequestSchema>;

/** The request, when it is well formed and names `hostname`. */
export function readHostBrowserRequest(
  raw: string,
  hostname: string,
): HostBrowserRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const request = HostBrowserRequestSchema.safeParse(parsed);
  if (!request.success || request.data.hostname !== hostname) return undefined;
  return request.data;
}

/**
 * The operator asking, from the machine page, for what `aflow folder <id>
 * preview` does on the machine: declare a folder's preview, or clear it (Plan
 * 320 D18). Published only by the operator route, which takes a person's
 * authenticated request — no operation dispatches it — and acted on only by
 * the executor of the machine it names, which writes it with the command's own
 * writer after checking the folder was connected for the workspace asking.
 * Its own channel pair rather than the browser's, because a browser request
 * is keyed by profile and this one by folder.
 */
export function hostFolderRequestChannel(hostname: string): string {
  return `aflow:pubsub:host-folder:${hostname}`;
}

export function hostFolderAnswerChannel(answerId: string): string {
  return `aflow:pubsub:host-folder-answer:${answerId}`;
}

export const HostFolderRequestSchema = z.object({
  kind: z.literal('preview'),
  hostname: z.string().min(1),
  answerId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  spaceId: z.string().min(1),
  bindingId: z.string().min(1).max(64),
  /** The declaration to write, or null to clear it. */
  preview: HostFolderPreviewSchema.nullable(),
});
export type HostFolderRequest = z.infer<typeof HostFolderRequestSchema>;

/** The request, when it is well formed and names `hostname`. */
export function readHostFolderRequest(
  raw: string,
  hostname: string,
): HostFolderRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const request = HostFolderRequestSchema.safeParse(parsed);
  if (!request.success || request.data.hostname !== hostname) return undefined;
  return request.data;
}

export const HostFolderAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('changed'), preview: HostFolderPreviewSchema.nullable() }),
  z.object({ kind: z.literal('refused'), message: z.string() }),
]);
export type HostFolderAnswer = z.infer<typeof HostFolderAnswerSchema>;

export const HostBrowserSettingAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('changed'), profile: BrowserProfileSchema }),
  z.object({ kind: z.literal('refused'), message: z.string() }),
]);
export type HostBrowserSettingAnswer = z.infer<typeof HostBrowserSettingAnswerSchema>;

/**
 * A loopback port a profile's policy lists, every one of them: open, or
 * `refused` with why when this stack serves on it, so a port written into the
 * file by hand is shown on the machine page and can be removed there.
 */
export const HostInventoryLocalPortSchema = z.object({
  port: BrowserLocalPortSchema,
  refused: z.string().optional(),
});
export type HostInventoryLocalPort = z.infer<typeof HostInventoryLocalPortSchema>;

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
/**
 * What this machine offers a model runtime on it (Plan 323 D8): its memory,
 * and the GPU working set, which no `sysctl` reports and the runtime's API
 * does not expose. Absent until the machine has read it.
 */
export const HostMachineSchema = z.object({
  totalMemoryBytes: z.number().int().positive(),
  gpuWorkingSetBytes: z.number().int().positive().optional(),
  unifiedMemory: z.boolean(),
  /**
   * Free space on the disk that holds the model runtime's downloads, read at
   * each publish, so a pull that cannot fit is refused before it starts.
   */
  freeDiskBytes: z.number().int().nonnegative().optional(),
});
export type HostMachine = z.infer<typeof HostMachineSchema>;

export const HostInventorySchema = z.object({
  hostname: z.string(),
  observedAt: z.string(),
  machine: HostMachineSchema.optional(),
  runtimes: z.array(z.object({ name: z.string(), version: z.string() })),
  /**
   * The harnesses the machine's policy configures, and whether each one's
   * executable is there to start. A configured harness that is not installed
   * is offered as such, so a workspace choosing one can see it will fall back.
   */
  harnesses: z.array(
    z.object({ id: z.string(), label: z.string().optional(), installed: z.boolean() }),
  ),
  /** The harness a run gets when neither it nor its workspace names one. */
  defaultHarness: z.string().optional(),
  /**
   * How many of those run at once on this machine; a run past it waits for one
   * to end.
   */
  maxConcurrentHarnessRuns: z.number().int().min(1),
  /**
   * The push posture of each folder this machine lets push, whether a
   * publication from it runs checks and which program, and the sandbox posture
   * its coding agents and checks run under, from the same policy file.
   * Published rather than
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
      mergePosture: HostMergePostureSchema.default(HOST_MERGE_POSTURE_DEFAULT),
      checks: HostPublishedChecksSchema.optional(),
      sandbox: HostSandboxPostureSchema,
    }),
  ),
  /**
   * Every folder the machine connected for a workspace, pushing or not, with
   * its preview as the person declared it (Plan 320 D18). Where none is
   * declared, `detectedWebApps` names the directories where the machine found
   * a web app — relative to the folder's root, `.` for the root — so the
   * machine page can say the preview is not declared; empty where it found
   * none. Detection is a hint for that line alone: nothing is run from it and
   * no default is taken from it. Apart from `folders`, which lists only the
   * folders that push.
   */
  previews: z.array(
    z.object({
      id: z.string(),
      spaceId: z.string(),
      preview: HostFolderPreviewSchema.optional(),
      detectedWebApps: z.array(z.string()),
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
      unattended: true,
      idleMinutes: true,
    }).extend({
      localPorts: z.array(HostInventoryLocalPortSchema).default([]),
      running: z.boolean(),
      windowOpen: z.boolean(),
      sites: z.array(z.string()).optional(),
    }),
  ),
});
export type HostInventory = z.infer<typeof HostInventorySchema>;
export type HostInventoryFolders = HostInventory['folders'];
export type HostInventoryPreviews = HostInventory['previews'];
export type HostInventoryBrowsers = HostInventory['browsers'];

/** What the machine holding a pushing folder declares about publishing from it. */
export interface PublishingFolder {
  readonly pushApproval: HostPushApproval;
  readonly mergePosture: HostMergePosture;
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
          mergePosture: folder.mergePosture,
          ...(folder.checks !== undefined ? { checks: folder.checks } : {}),
        });
      }
    }
  }
  return folders;
}

/** A folder's preview as the machine holding it publishes it, and which machine that is. */
export interface PublishedFolderPreview {
  readonly hostname: string;
  readonly preview?: HostInventoryPreviews[number]['preview'];
  readonly detectedWebApps: readonly string[];
}

/**
 * Each folder's preview for one workspace, as the machines publishing now
 * declare it, with the machine to ask to change it. A folder missing here has
 * no machine running for it.
 */
export function folderPreviewsForSpace(
  inventories: ReadonlyArray<Pick<HostInventory, 'hostname' | 'previews'>>,
  spaceId: string,
): Map<string, PublishedFolderPreview> {
  const previews = new Map<string, PublishedFolderPreview>();
  for (const machine of inventories) {
    for (const folder of machine.previews) {
      if (folder.spaceId !== spaceId || previews.has(folder.id)) continue;
      previews.set(folder.id, {
        hostname: machine.hostname,
        ...(folder.preview !== undefined ? { preview: folder.preview } : {}),
        detectedWebApps: folder.detectedWebApps,
      });
    }
  }
  return previews;
}

/** One machine's inventory, when it is publishing one that reads. */
export async function readHostInventory(
  redis: Pick<HostInventoryReader, 'get'>,
  hostname: string,
): Promise<HostInventory | undefined> {
  const raw = await redis.get(hostInventoryKey(hostname));
  if (raw === null) return undefined;
  try {
    return HostInventorySchema.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
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

/**
 * The machine a model runtime on the appliance's own host runs on, as the
 * paired machine publishes it. The local edition has one host; a second
 * publisher would be a second machine, and only the first answers.
 */
export async function readLocalMachine(
  redis: HostInventoryReader,
): Promise<HostMachine | undefined> {
  return (await readLocalHost(redis))?.machine;
}

/** The same machine, with the name its executor listens under. */
export async function readLocalHost(
  redis: HostInventoryReader,
): Promise<{ hostname: string; machine: HostMachine } | undefined> {
  for (const inventory of await readLiveHostInventories(redis)) {
    if (inventory.machine) return { hostname: inventory.hostname, machine: inventory.machine };
  }
  return undefined;
}
