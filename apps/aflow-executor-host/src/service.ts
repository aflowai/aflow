/**
 * Keeping the executor running without the operator thinking about it.
 *
 * The lane is only reachable while this process is up, and it was a process in
 * a terminal: close the window, reboot, and folders connected weeks ago quietly
 * stop answering. Nothing is broken and nothing says so — the appliance reports
 * no host executor, which is true and unhelpful, because the remedy is a command
 * in a directory the operator may not remember.
 *
 * A launch agent is macOS's answer to exactly this, and the platform's own:
 * started at login, restarted if it dies, owned by the user rather than by root.
 * Installing one is a change to the operator's machine, so it is a command they
 * run rather than something connecting a folder does on their behalf.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const LABEL = 'ai.aflow.host-executor';
const HOST_DIR = process.env['PHOENIX_HOST_DIR']?.trim() ?? resolve(homedir(), '.aflow');

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/**
 * Escaped because a checkout path is the operator's, not ours — a repository
 * under "Ben & Jerry's" would otherwise produce a plist that will not parse,
 * and launchd's complaint about it names the file rather than the reason.
 */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPlist(repoRoot: string, logPath: string): string {
  // A login shell, so the agent finds the same node and yarn the operator does.
  // launchd starts with almost no PATH, and an executor that cannot find node is
  // a failure that looks identical to one nobody started.
  const command =
    `cd ${JSON.stringify(repoRoot)} && ` +
    "NODE_OPTIONS='--conditions=ts-source' exec npx tsx apps/aflow-executor-host/src/index.ts";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${xml(command)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function usage(): never {
  console.error(
    'Usage: service <install|uninstall|status>\n\n' +
      '  install    Run the executor at login and keep it running\n' +
      '  uninstall  Stop it and remove the launch agent\n' +
      '  status     Say whether it is installed and running',
  );
  process.exit(2);
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run('launchctl', args);
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) };
  }
}

/** The user's own domain — this never asks for, and never needs, root. */
function domain(): string {
  return `gui/${String(process.getuid?.() ?? 501)}`;
}

/**
 * Wait for a previous registration to actually go.
 *
 * `bootout` returns before launchd has finished tearing the job down, so a
 * `bootstrap` issued straight afterwards hits a label still registered and
 * fails with `5: Input/output error` — a message that says nothing about the
 * cause and sends the reader looking at their plist, which is fine. Reproduced
 * deliberately: bootout then bootstrap, back to back, fails every time.
 */
async function untilUnregistered(deadlineMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const printed = await launchctl('print', `${domain()}/${LABEL}`);
    if (!printed.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * `EIO` from launchd is not always about the job. It also appears while the
 * domain is busy, and once for a plist carrying `com.apple.provenance` — an
 * attribute macOS adds on its own and does not let you remove. Retrying is the
 * remedy for the transient half, and the error is reported verbatim when it is
 * not, since guessing at launchd's reasons is how this cost an evening.
 */
async function bootstrapWithRetry(attempts = 3): Promise<{ ok: boolean; out: string }> {
  let last = { ok: false, out: 'not attempted' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await launchctl('bootstrap', domain(), plistPath());
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return last;
}

async function install(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'Launch agents are macOS. On another platform, run `yarn executor:host` under whatever ' +
        'keeps your services alive.',
    );
  }
  const repoRoot = process.env['PROJECT_CWD']?.trim() ?? process.cwd();
  const logPath = join(HOST_DIR, 'host-executor.log');
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(HOST_DIR, { recursive: true, mode: 0o700 });

  // Replaced rather than merged: an agent from an older checkout would keep
  // pointing at it, and two of them would claim the same jobs.
  await launchctl('bootout', `${domain()}/${LABEL}`);
  await untilUnregistered();
  await writeFile(plistPath(), renderPlist(repoRoot, logPath), { mode: 0o644 });

  const loaded = await bootstrapWithRetry();
  if (!loaded.ok) {
    throw new Error(
      `launchctl refused the agent: ${loaded.out.slice(0, 300)}\n` +
        `The plist is at ${plistPath()} — \`launchctl bootstrap ${domain()} <that path>\` ` +
        'reports the same failure by hand.',
    );
  }
  console.log(`Installed. The host executor runs at login and restarts if it stops.`);
  console.log(`  from ${repoRoot}`);
  console.log(`  log  ${logPath}`);
}

async function uninstall(): Promise<void> {
  await launchctl('bootout', `${domain()}/${LABEL}`);
  await rm(plistPath(), { force: true });
  console.log('Removed. Folders stay connected; nothing on this machine answers for them now.');
}

async function status(): Promise<void> {
  const installed = await readFile(plistPath(), 'utf8').then(
    () => true,
    () => false,
  );
  if (!installed) {
    console.log('Not installed. `service install` runs it at login.');
    return;
  }
  const listed = await launchctl('print', `${domain()}/${LABEL}`);
  console.log(
    listed.ok ? 'Installed and loaded by launchd.' : 'Installed, but launchd does not have it.',
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'install') {
    await install();
    return;
  }
  if (command === 'uninstall') {
    await uninstall();
    return;
  }
  if (command === 'status') {
    await status();
    return;
  }
  usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
