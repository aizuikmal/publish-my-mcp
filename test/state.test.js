import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as state from '../src/state.js';

const mkHome = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-home-')));
const mode = (f) => fs.statSync(f).mode & 0o777;

test('key: env wins, file is written 600', async () => {
  const home = mkHome();
  assert.equal(await state.readKey({ home, env: {} }), null);
  await state.saveKey('pm_abc', { home });
  assert.equal(await state.readKey({ home, env: {} }), 'pm_abc');
  assert.equal(mode(path.join(home, '.publishmy')), 0o600);
  assert.equal(await state.readKey({ home, env: { PUBLISHMY_API_KEY: 'pm_env' } }), 'pm_env');
});

test('key file tightened to 600 even if it already existed wider', async () => {
  const home = mkHome();
  fs.writeFileSync(path.join(home, '.publishmy'), 'old', { mode: 0o644 });
  await state.saveKey('pm_new', { home });
  assert.equal(mode(path.join(home, '.publishmy')), 0o600);
});

test('pending store lives under ~/.config, 600, add and remove', async () => {
  const home = mkHome();
  await state.setPending('88aaaaaaaa', { deploy_secret: 's' }, { home });
  const f = path.join(home, '.config', 'publish-my', 'pending.json');
  assert.equal(mode(f), 0o600);
  assert.equal((await state.readPending({ home }))['88aaaaaaaa'].deploy_secret, 's');
  await state.setPending('88aaaaaaaa', null, { home });
  assert.deepEqual(await state.readPending({ home }), {});
});

test('breadcrumb for a build folder goes to the project root, and is found again', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj'); fs.mkdirSync(path.join(proj, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  const file = await state.writeBreadcrumb(path.join(proj, 'dist'), { projectId: '88bbbbbbbb', url: 'https://88bbbbbbbb.publish.my' }, { home });
  assert.equal(file, path.join(proj, '.publish-my.json'));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.site_path, 'dist');
  assert.equal(data.instructions, 'https://publish.my/llms.txt');
  assert.equal((await state.findBreadcrumb(path.join(proj, 'dist'), { home })).data.project_id, '88bbbbbbbb');
});

test('a sibling folder in the same project does not inherit the breadcrumb', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, 'dist'), { recursive: true }); fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'));
  await state.writeBreadcrumb(path.join(proj, 'dist'), { projectId: '88cccccccc', url: 'u' }, { home });
  assert.equal(await state.findBreadcrumb(path.join(proj, 'docs'), { home }), null);
  // ...and publishing docs/ writes its own breadcrumb instead of clobbering dist/'s
  const f2 = await state.writeBreadcrumb(path.join(proj, 'docs'), { projectId: '88dddddddd', url: 'u2' }, { home });
  assert.equal(f2, path.join(proj, 'docs', '.publish-my.json'));
  assert.equal((await state.findBreadcrumb(path.join(proj, 'dist'), { home })).data.project_id, '88cccccccc');
});

test('legacy curl-flow breadcrumb (no site_path) only identifies the folder it sits in', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj'); fs.mkdirSync(path.join(proj, 'out'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  fs.writeFileSync(path.join(proj, '.publish-my.json'), JSON.stringify({ project_id: '88eeeeeeee', url: 'u' }));
  assert.equal((await state.findBreadcrumb(proj, { home })).data.project_id, '88eeeeeeee');
  assert.equal(await state.findBreadcrumb(path.join(proj, 'out'), { home }), null, 'a subfolder must not inherit it');
});

test('never walks above home', async () => {
  const home = mkHome();
  const site = path.join(home, 'a', 'b'); fs.mkdirSync(site, { recursive: true });
  assert.equal(await state.projectRoot(site, { home }), site);
});
