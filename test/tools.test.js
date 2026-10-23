// Tool behaviour against a fake API (the real-server path is covered by scripts/e2e-dev.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../src/tools.js';
import * as state from '../src/state.js';

function setup({ key = null } = {}) {
  let publicFails = false;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tools-')));
  const site = path.join(home, 'site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>hi</h1>');
  if (key) fs.writeFileSync(path.join(home, '.publishmy'), key);
  const calls = [];
  const projects = {}; // id -> status
  let exchangeReply = { status: 202, body: { status: 'pending' } };
  const api = {
    async deploy(a) {
      calls.push({ fn: 'deploy', ...a, tarball: a.tarball.length });
      if (a.projectId && projects[a.projectId] === 'staged' && a.key) return { status: 403, body: { error: { code: 'not_owner', message: 'not your project' } } };
      if (a.projectId) { return { status: 200, body: { project_id: a.projectId, url: `https://${a.projectId}.publish.my`, status: projects[a.projectId] === 'staged' && !a.key ? 'staged' : 'live', warnings: [] } }; }
      const id = '88' + 'x'.repeat(8);
      if (a.key) { projects[id] = 'live'; return { status: 200, body: { project_id: id, url: `https://${id}.publish.my`, status: 'live', warnings: [] } }; }
      projects[id] = 'staged';
      return { status: 201, body: { project_id: id, url: `https://${id}.publish.my`, status: 'staged', deploy_secret: 'sec', agent_exchange_token: 'tok', expires_at: 'z', warnings: [] } };
    },
    async publicInfo(id) { calls.push({ fn: 'publicInfo', id }); if (publicFails) return { status: 503, body: { error: { code: 'unavailable', message: 'down' } } }; return projects[id] ? { status: 200, body: { exists: true, status: projects[id] } } : { status: 404, body: { exists: false } }; },
    async exchange(t) { calls.push({ fn: 'exchange', t }); return exchangeReply; },
    async projects() { return { status: 200, body: Object.entries(projects).map(([id, status]) => ({ id, url: `https://${id}.publish.my`, status, hits_30d: 3 })) }; },
    async relink(id) { calls.push({ fn: 'relink', id }); return projects[id] === 'live' ? { status: 202, body: { agent_exchange_token: 'rtok', expires_at: 'z' } } : { status: 409, body: { error: { code: 'not_activated', message: 'no' } } }; },
  };
  const tools = createTools({ api, home, env: {}, pollIntervalMs: 60_000 });
  return { home, site, calls, projects, api, tools, setExchange: (r) => { exchangeReply = r; }, failPublic: () => { publicFails = true; } };
}

test('first anonymous publish: staged, pending saved, breadcrumb written, activation picks up key', async (t) => {
  const s = setup();
  t.after(() => s.tools.stopAll());
  const r = await s.tools.publishSite({ path: s.site });
  assert.equal(r.data.status, 'staged');
  assert.match(r.text, /enter your email/i);
  assert.ok(s.tools._watchers.has(r.data.project_id), 'background poll started');
  const pending = await state.readPending({ home: s.home });
  assert.equal(pending[r.data.project_id].deploy_secret, 'sec');
  assert.ok(fs.existsSync(path.join(s.site, '.publish-my.json')));

  // still pending
  let c = await s.tools.checkActivation({});
  assert.equal(c.data.results[0].status, 'pending');
  // user clicks the email link
  s.setExchange({ status: 200, body: { api_key: 'pm_live' } });
  c = await s.tools.checkActivation({});
  assert.equal(c.data.results[0].status, 'live');
  assert.equal(await state.readKey({ home: s.home, env: {} }), 'pm_live');
  assert.deepEqual(await state.readPending({ home: s.home }), {});
  assert.equal(s.tools._watchers.size, 0);
});

test('re-publishing a staged site uses the deploy secret, no confirmation needed', async (t) => {
  const s = setup();
  t.after(() => s.tools.stopAll());
  const first = await s.tools.publishSite({ path: s.site });
  const again = await s.tools.publishSite({ path: s.site });
  assert.equal(again.data.project_id, first.data.project_id);
  const d = s.calls.filter((c) => c.fn === 'deploy').at(-1);
  assert.equal(d.deploySecret, 'sec'); assert.equal(d.projectId, first.data.project_id);
});

test('re-publishing a LIVE site needs confirm_update, then goes through with the key', async () => {
  const s = setup({ key: 'pm_k' });
  const first = await s.tools.publishSite({ path: s.site });
  assert.equal(first.data.status, 'live');
  const blocked = await s.tools.publishSite({ path: s.site });
  assert.equal(blocked.data.status, 'needs_confirmation');
  assert.equal(s.calls.filter((c) => c.fn === 'deploy').length, 1, 'no upload without confirmation');
  const ok = await s.tools.publishSite({ path: s.site, confirm_update: true });
  assert.equal(ok.data.status, 'live'); assert.equal(ok.data.project_id, first.data.project_id);
  assert.equal(s.calls.at(-1).key, 'pm_k');
});

test('new_site ignores the breadcrumb', async () => {
  const s = setup({ key: 'pm_k' });
  await s.tools.publishSite({ path: s.site });
  const r = await s.tools.publishSite({ path: s.site, new_site: true });
  assert.equal(s.calls.at(-1).fn, 'deploy'); assert.equal(s.calls.at(-1).projectId, null);
  assert.equal(r.data.status, 'live');
});

test('breadcrumb of a purged site: publishes as new and says so', async (t) => {
  const s = setup();
  t.after(() => s.tools.stopAll());
  fs.writeFileSync(path.join(s.site, '.publish-my.json'), JSON.stringify({ project_id: '88gonegone', url: 'u' }));
  const r = await s.tools.publishSite({ path: s.site });
  assert.match(r.text, /no longer exists/);
  assert.equal(s.calls.find((c) => c.fn === 'deploy').projectId, null);
});

test('live site, but this machine has no key: points at reconnect_site, uploads nothing', async () => {
  const s = setup();
  s.projects['88livelive'] = 'live';
  fs.writeFileSync(path.join(s.site, '.publish-my.json'), JSON.stringify({ project_id: '88livelive', url: 'u' }));
  const r = await s.tools.publishSite({ path: s.site, confirm_update: true });
  assert.equal(r.isError, true); assert.match(r.text, /reconnect_site/);
  assert.equal(s.calls.filter((c) => c.fn === 'deploy').length, 0);
});

test('missing index.html is a clear tool error, not a throw', async () => {
  const s = setup();
  fs.rmSync(path.join(s.site, 'index.html'));
  const r = await s.tools.publishSite({ path: s.site });
  assert.equal(r.isError, true); assert.match(r.text, /index\.html/);
});

test('list_sites without a key explains how to get one', async () => {
  const s = setup();
  const r = await s.tools.listSites();
  assert.equal(r.isError, true); assert.match(r.text, /console\.publish\.my/);
});

test('reconnect_site finds the id from the folder breadcrumb and starts watching', async (t) => {
  const s = setup();
  t.after(() => s.tools.stopAll());
  s.projects['88livelive'] = 'live';
  fs.writeFileSync(path.join(s.site, '.publish-my.json'), JSON.stringify({ project_id: '88livelive', url: 'u' }));
  const r = await s.tools.reconnectSite({ path: s.site });
  assert.equal(r.data.status, 'pending');
  assert.equal(s.calls.at(-1).id, '88livelive');
  assert.ok(s.tools._watchers.has('88livelive'));
});

test('exchange 410 with a key already saved (another session got it) counts as live', async (t) => {
  const s = setup();
  t.after(() => s.tools.stopAll());
  const r = await s.tools.publishSite({ path: s.site });
  fs.writeFileSync(path.join(s.home, '.publishmy'), 'pm_other');
  s.setExchange({ status: 410, body: { error: { code: 'gone' } } });
  const c = await s.tools.checkActivation({ project_id: r.data.project_id });
  assert.equal(c.data.results[0].status, 'live');
});

test('staged site re-published while a key exists (another site activated): uses the deploy secret', async (t) => {
  const s = setup();
  t.after(() => s.tools.stopAll());
  const first = await s.tools.publishSite({ path: s.site });
  fs.writeFileSync(path.join(s.home, '.publishmy'), 'pm_from_other_site');
  const again = await s.tools.publishSite({ path: s.site });
  assert.ok(!again.isError, again.text);
  const d = s.calls.filter((c) => c.fn === 'deploy').at(-1);
  assert.equal(d.key, null); assert.equal(d.deploySecret, 'sec'); assert.equal(d.projectId, first.data.project_id);
});

test('status lookup failure never falls through to an unconfirmed overwrite', async () => {
  const s = setup({ key: 'pm_k' });
  await s.tools.publishSite({ path: s.site });
  s.failPublic();
  const r = await s.tools.publishSite({ path: s.site });
  assert.equal(r.isError, true); assert.match(r.text, /Nothing was uploaded/);
  assert.equal(s.calls.filter((c) => c.fn === 'deploy').length, 1);
});

test('breadcrumb write failure after a staged deploy keeps the secret and says how to update', async (t) => {
  const s = setup();
  t.after(() => { s.tools.stopAll(); fs.chmodSync(s.site, 0o755); });
  fs.chmodSync(s.site, 0o555); // read-only folder: breadcrumb can't be written
  const r = await s.tools.publishSite({ path: s.site });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Couldn't write \.publish-my\.json/);
  assert.equal((await state.readPending({ home: s.home }))[r.data.project_id].deploy_secret, 'sec');
  assert.ok(s.tools._watchers.has(r.data.project_id));
});

test('staged site without its secret on this machine: clear error, no upload', async () => {
  const s = setup({ key: 'pm_k' });
  s.projects['88stagedxx'] = 'staged';
  const r = await s.tools.publishSite({ path: s.site, project_id: '88stagedxx' });
  assert.equal(r.isError, true); assert.match(r.text, /waiting for activation/);
  assert.equal(s.calls.filter((c) => c.fn === 'deploy').length, 0);
});
