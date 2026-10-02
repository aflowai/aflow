/**
 * The environment a profile's Chrome starts with, and nothing more.
 *
 * Named rather than inherited: this executor's own environment holds the
 * credential it was paired with, and the git transport's carries the
 * operator's forge tokens and SSH agent. A browser that runs every page's
 * scripts needs none of them — only what it takes to start, find its home and
 * temporary directory, speak the operator's language, and, on Linux, reach the
 * display and session bus a visible window needs.
 */
const BROWSER_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;

const LINUX_DISPLAY_ENV_NAMES = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

export function browserServiceEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const names = [
    ...BROWSER_ENV_NAMES,
    ...Object.keys(source).filter((name) => name.startsWith('LC_')),
    ...(platform === 'linux' ? LINUX_DISPLAY_ENV_NAMES : []),
  ];
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
