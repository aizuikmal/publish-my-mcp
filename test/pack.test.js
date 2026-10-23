import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extract } from 'tar-stream';
import { packFolder, PackError } from '../src/pack.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pm-pack-'));
const write = (root, rel, data = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };

async function entries(buf) {
  const names = [];
  const ex = extract();
  ex.on('entry', (h, s, next) => { names.push(h.name); s.resume(); s.on('end', next); });
  const done = new Promise((r) => ex.on('finish', r));
  ex.end(zlib.gunzipSync(buf));
  await done;
  return names.sort();
}

test('packs allowed files with index.html at the root', async () => {
  const d = tmp();
  write(d, 'index.html', '<h1>hi</h1>');
  write(d, 'css/site.css');
  write(d, 'img/a.webp');
  const r = await packFolder(d);
  assert.deepEqual(await entries(r.buffer), ['css/site.css', 'img/a.webp', 'index.html']);
  assert.equal(r.fileCount, 3);
});

test('skips dotfiles, node_modules, AppleDouble, disallowed types and symlinks', async () => {
  const d = tmp();
  write(d, 'index.html');
  write(d, '.env', 'SECRET=1');
  write(d, '._index.html');
  write(d, '.DS_Store');
  write(d, '.git/config');
  write(d, '.publish-my.json', '{}');
  write(d, 'node_modules/x/index.js');
  write(d, 'server.php');
  write(d, 'notes.docx');
  fs.symlinkSync('/etc/hosts', path.join(d, 'link.txt'));
  const r = await packFolder(d);
  assert.deepEqual(await entries(r.buffer), ['index.html']);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons['.env'], 'hidden file');            // reported, so the agent can warn about secrets
  assert.equal(reasons['server.php'], 'file type not allowed');
  assert.equal(reasons['notes.docx'], 'file type not allowed');
  assert.equal(reasons['node_modules/'], 'dependency folder');
  assert.equal(reasons['link.txt'], 'symlink');
  assert.ok(!('._index.html' in reasons) && !('.DS_Store' in reasons), 'OS junk is skipped silently');
});

test('no index.html: names the framework and the built output folder', async () => {
  const d = tmp();
  write(d, 'package.json', '{}');
  write(d, 'vite.config.ts');
  write(d, 'dist/index.html');
  await assert.rejects(packFolder(d), (e) => {
    assert.ok(e instanceof PackError); assert.equal(e.code, 'no_index');
    assert.match(e.message, /Vite/); assert.match(e.message, /dist/);
    return true;
  });
});

test('too many files is refused before upload', async () => {
  const d = tmp();
  write(d, 'index.html'); write(d, 'a.txt'); write(d, 'b.txt');
  await assert.rejects(packFolder(d, { maxFiles: 2, maxTarballBytes: 1e9 }), { code: 'too_many_files' });
});

test('oversized archive is refused before upload', async () => {
  const d = tmp();
  write(d, 'index.html', 'x'.repeat(10));
  write(d, 'big.mp4', Buffer.from(Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256))));
  await assert.rejects(packFolder(d, { maxFiles: 10, maxTarballBytes: 1024 }), { code: 'too_large' });
});

test('not a folder', async () => {
  await assert.rejects(packFolder('/nonexistent/pm-xyz'), { code: 'not_a_folder' });
});
