/**
 * Boot-and-surface smoke for the local appliance.
 *
 * Unit tests cover the code; this covers the artifact. Every appliance defect
 * so far — the terms gate that blocked first boot, the dev-bypass
 * announcement, the seven-way parallel build — was invisible to both the type
 * checker and the suite and appeared only when the thing was run.
 *
 * Scope is the boot and the composed surface. The model-dependent product
 * paths need a provider credential, which is entered through the UI into the
 * encrypted per-space store, so they stay manual until seeding one is
 * scriptable. Named accordingly: this does not prove the product works, it
 * proves the appliance came up composed the way the edition says.
 */
/**
 * `scope` selects which container this run belongs in. The web app answers only
 * to the hosts it was configured to answer to, so a request reaching it as
 * `web:3001` is refused before anything else happens — the check has to
 * originate somewhere that guard accepts, which is the web container itself.
 */
const SCOPE = process.env['SMOKE_SCOPE'] ?? 'api';
const API = process.env['SMOKE_API_URL'];
const WEB = process.env['SMOKE_WEB_URL'];
const SECRET = process.env['SMOKE_INSTANCE_SECRET'];

if (SCOPE === 'api' && (API === undefined || SECRET === undefined)) {
  console.error('SMOKE_API_URL and SMOKE_INSTANCE_SECRET are required');
  process.exit(2);
}
if (SCOPE === 'web' && WEB === undefined) {
  console.error('SMOKE_WEB_URL is required');
  process.exit(2);
}

const auth = { Authorization: `Bearer ${SECRET}` };
const results = [];

async function check(scope, name, fn) {
  if (scope !== SCOPE) return;
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path, init) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...auth, ...init?.headers },
  });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, raw: body };
}

await check('api', 'api health reports its dependencies', async () => {
  const { status, body } = await json('/health');
  expect(status === 200, `expected 200, got ${status}`);
  expect(body?.status === 'ok', `status was ${body?.status}`);
  expect(body?.checks?.database === 'ok', `database was ${body?.checks?.database}`);
  expect(body?.checks?.redis === 'ok', `redis was ${body?.checks?.redis}`);
  return 'database ok, redis ok';
});

await check('api', 'the process reports the local edition and its surfaces', async () => {
  const { status, body } = await json('/v1/users/me');
  expect(status === 200, `expected 200, got ${status}`);
  expect(body?.edition?.id === 'community-local', `edition was ${body?.edition?.id}`);
  const surfaces = body?.edition?.surfaces;
  expect(Array.isArray(surfaces) && surfaces.length > 0, 'no surfaces reported');
  return `community-local, ${surfaces.length} surfaces`;
});

await check('api', 'an enterprise surface is absent rather than forbidden', async () => {
  const { status } = await json('/v1/admin/errors');
  expect(status === 404, `expected 404 from an uncomposed route, got ${status}`);
  return 'admin/errors 404';
});

// At least one, not exactly one: bootstrap preserves the workspaces an
// instance already has, so an appliance in use has as many as its operator
// made. Pristine is a property of a fresh boot, not of a working instance.
await check('api', 'the owner has a workspace to enter', async () => {
  const { status, body } = await json('/v1/spaces');
  expect(status === 200, `expected 200, got ${status}`);
  const spaces = Array.isArray(body) ? body : (body?.spaces ?? body?.data);
  expect(Array.isArray(spaces), 'spaces was not a list');
  expect(spaces.length >= 1, 'no workspaces');
  return `${spaces.length} (${spaces.map((s) => s?.slug ?? '?').join(', ')})`;
});

await check('api', 'the operation catalog is populated', async () => {
  const { status, body } = await json('/v1/catalog/operations');
  expect(status === 200, `expected 200, got ${status}`);
  const operations = Array.isArray(body) ? body : (body?.operations ?? body?.data);
  expect(Array.isArray(operations) && operations.length > 0, 'catalog was empty');
  return `${operations.length} operations`;
});

// The destination is asserted, not merely followed: a redirect to somewhere
// else entirely — or off-origin — also answers 200, and would pass a check
// that only reported what it landed on. `/chat` before a space exists, the
// space's own chat once one does — which is every instance after first use.
const CHAT_ENTRY = /^\/(?:s\/[a-z0-9][a-z0-9-]*\/)?chat$/;

await check('web', 'the web app serves the chat entry point', async () => {
  const root = await fetch(WEB, { redirect: 'manual' });
  expect(root.status >= 300 && root.status < 400, `expected a redirect from /, got ${root.status}`);
  const location = root.headers.get('location');
  expect(location !== null, 'redirect carried no location');
  const target = new URL(location, WEB);
  expect(target.origin === new URL(WEB).origin, `redirected off-origin, to ${target.origin}`);
  expect(CHAT_ENTRY.test(target.pathname), `expected a chat entry point, got ${target.pathname}`);
  const page = await fetch(target);
  expect(page.status === 200, `expected 200 from ${target.pathname}, got ${page.status}`);
  return `/ -> ${target.pathname} 200`;
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
