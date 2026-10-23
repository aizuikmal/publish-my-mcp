// End-to-end: the real stdio MCP server against a real publish.my app in DEV_MODE.
// Run via scripts/e2e-dev.sh, which boots the app and sets PM_BASE / PM_LOG / PM_SITES / HOME.
// One MCP session for the whole run, so the background activation poll is exercised too.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

const { PM_BASE: base, PM_LOG: logFile, PM_SITES: sitesDir, HOME: home } = process.env;
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };

const site = path.join(home, 'proj', 'site');
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(path.join(home, 'proj', 'package.json'), '{}');
const page = (v) => fs.writeFileSync(path.join(site, 'index.html'), `<!doctype html><title>t</title><h1>version ${v}</h1>`);
page(1);
fs.writeFileSync(path.join(site, '.env'), 'SECRET=1');

const client = new Client({ name: 'pm-e2e', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../src/index.js', import.meta.url).pathname],
  env: { ...process.env, PUBLISHMY_API_URL: base, PUBLISHMY_POLL_MS: '300' },
  stderr: 'inherit',
}));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
};
const idFrom = (t) => (t.match(/https?:\/\/(88[a-z0-9]{8})\.publish\.my/) || [])[1];
const liveFile = (id) => { try { return fs.readFileSync(path.join(sitesDir, id, 'index.html'), 'utf8'); } catch { return ''; } };

// Console flow, as tests/e2e.sh does it: GET sets the CSRF cookie, POST confirms.
async function consoleConfirm(kind, extra = {}) {
  const log = fs.readFileSync(logFile, 'utf8');
  const tok = [...log.matchAll(new RegExp(`console\\.publish\\.my/${kind}/([A-Za-z0-9_-]+)`, 'g'))].at(-1)?.[1];
  if (!tok) return false;
  const g = await fetch(`${base}/console/${kind}/${tok}`);
  const cookies = g.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('pmcsrf='))?.split('=')[1];
  const p = await fetch(`${base}/console/${kind}/${tok}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies.join('; ') },
    body: new URLSearchParams({ csrf, ...extra }),
  });
  return p.status < 400;
}

console.log('── 1. tools/list');
const tl = await client.listTools();
ok(tl.tools.map((t) => t.name).sort().join(',') === 'check_activation,list_sites,publish_site,reconnect_site', 'four tools');

console.log('── 2. first publish (no key) → staged');
let r = await call('publish_site', { path: site });
const id = idFrom(r.text);
ok(!r.isError && /enter your email/i.test(r.text), 'staged, tells the user to activate', r.text);
ok(!!id, `project id ${id}`);
ok(/"\.env" \(hidden file\)/.test(r.text), '.env reported as left out');
const crumb = JSON.parse(fs.readFileSync(path.join(home, 'proj', '.publish-my.json'), 'utf8'));
ok(crumb.project_id === id && crumb.site_path === 'site', 'breadcrumb at project root with site_path');
ok(!fs.existsSync(path.join(home, '.publishmy')), 'no key yet');

console.log('── 3. re-publish while staged → same id via deploy secret');
page(2);
r = await call('publish_site', { path: site });
ok(!r.isError && idFrom(r.text) === id, 'same project, no confirmation asked', r.text);

console.log('── 4. user activates → background poll saves the key');
const cl = await fetch(`${base}/v1/projects/${id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'mcp-e2e@example.com' }) });
ok(cl.status === 202, 'claim email requested');
ok(await consoleConfirm('claim', { agree: '1' }), 'console activation');
ok(await waitFor(() => fs.existsSync(path.join(home, '.publishmy'))), 'key saved by the background poll');
ok((fs.statSync(path.join(home, '.publishmy')).mode & 0o777) === 0o600, 'key file 600');
ok(liveFile(id).includes('version 2'), 'live site has version 2');
r = await call('check_activation');
ok(/Nothing is waiting/.test(r.text), 'check_activation: nothing pending', r.text);

console.log('── 5. update a live site needs confirmation');
page(3);
r = await call('publish_site', { path: site });
ok(/confirm_update/.test(r.text) && liveFile(id).includes('version 2'), 'refused without confirm_update; live untouched', r.text);
r = await call('publish_site', { path: site, confirm_update: true });
ok(!r.isError && /Live at/.test(r.text), 'published with confirm_update', r.text);
ok(liveFile(id).includes('version 3'), 'live site has version 3');

console.log('── 6. list_sites');
r = await call('list_sites');
ok(r.text.includes(id), 'lists the site', r.text);

console.log('── 7. second folder publishes straight to live (key present)');
const site2 = path.join(home, 'other'); fs.mkdirSync(site2); fs.writeFileSync(path.join(site2, 'index.html'), '<h1>other</h1>');
r = await call('publish_site', { path: site2 });
const id2 = idFrom(r.text);
ok(!r.isError && id2 && id2 !== id && /Live at/.test(r.text), 'new site live immediately', r.text);

console.log('── 8. lost key → reconnect_site → owner confirms → key back');
fs.rmSync(path.join(home, '.publishmy'));
page(4);
r = await call('publish_site', { path: site, confirm_update: true });
ok(r.isError && /reconnect_site/.test(r.text), 'publish without key points to reconnect_site', r.text);
r = await call('reconnect_site', { path: site });
ok(!r.isError && /confirm link/.test(r.text), 'relink requested', r.text);
ok(await consoleConfirm('relink'), 'owner confirms relink');
ok(await waitFor(() => fs.existsSync(path.join(home, '.publishmy'))), 'key restored by the background poll');
r = await call('publish_site', { path: site, confirm_update: true });
ok(!r.isError && liveFile(id).includes('version 4'), 'update works again', r.text);

console.log('── 9. errors');
const bad = path.join(home, 'vite'); fs.mkdirSync(path.join(bad, 'dist'), { recursive: true });
fs.writeFileSync(path.join(bad, 'vite.config.ts'), ''); fs.writeFileSync(path.join(bad, 'dist', 'index.html'), 'x');
r = await call('publish_site', { path: bad });
ok(r.isError && /dist/.test(r.text) && /Vite/.test(r.text), 'no index.html → points at dist/', r.text);

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
