// Folder -> .tar.gz the deploy API accepts (index.html at the archive root).
// Mirrors the server's rules in publish-my app/src/tar/validate.js so the agent learns about a
// problem before uploading, but the server stays the authority: anything we let through it
// re-checks, and anything it skips it reports back as a warning.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pack as tarPack } from 'tar-stream';

export const ALLOWED_EXT = new Set([
  'html', 'css', 'js', 'mjs', 'json', 'txt', 'csv', 'xml', 'pdf',
  'png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'ico', 'avif',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a',
  'woff', 'woff2', 'ttf', 'otf', 'map', 'webmanifest',
]);

export const LIMITS = {
  maxTarballBytes: 50 * 1024 * 1024, // free-tier upload cap (compressed)
  maxFiles: 2000,
};

// Never descend into these; they are never part of a site and can be huge.
const SKIP_DIRS = new Set(['node_modules']);

// Where common frameworks put their static export — used only to make "no index.html" helpful.
const FRAMEWORKS = [
  { files: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'], name: 'Next.js', out: 'out', fix: "set `output: 'export'` in next.config, run `next build`, then publish the `out/` folder" },
  { files: ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts'], name: 'SvelteKit', out: 'build', fix: 'use `@sveltejs/adapter-static`, run the build, then publish the `build/` folder' },
  { files: ['nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.ts'], name: 'Nuxt', out: '.output/public', fix: 'run `nuxt generate`, then publish the `.output/public/` folder' },
  { files: ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'], name: 'Astro', out: 'dist', fix: 'run `astro build`, then publish the `dist/` folder' },
  { files: ['vite.config.js', 'vite.config.mjs', 'vite.config.ts'], name: 'Vite', out: 'dist', fix: 'run `npm run build`, then publish the `dist/` folder' },
];
const OUTPUT_DIRS = ['dist', 'out', 'build', '.output/public', '_site', 'public'];

export class PackError extends Error {
  constructor(code, message) { super(message); this.name = 'PackError'; this.code = code; }
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

// Explains a folder without index.html: the framework we recognise and any build output that
// already contains an index.html (the folder the agent probably meant).
export async function diagnoseMissingIndex(dir) {
  let framework = null;
  for (const f of FRAMEWORKS) {
    for (const file of f.files) {
      if (await exists(path.join(dir, file))) { framework = f; break; }
    }
    if (framework) break;
  }
  const builtOutputs = [];
  for (const o of OUTPUT_DIRS) {
    if (await exists(path.join(dir, o, 'index.html'))) builtOutputs.push(path.join(dir, o));
  }
  const lines = [`No index.html at the top of ${dir}. publish.my hosts static files and the homepage must be index.html at the root of the folder you publish.`];
  if (builtOutputs.length) lines.push(`Found built output that has one: ${builtOutputs.join(', ')} — publish that folder instead.`);
  if (framework) lines.push(`This looks like a ${framework.name} project: ${framework.fix}.`);
  else if (await exists(path.join(dir, 'package.json')) && !builtOutputs.length) lines.push('This looks like a JavaScript project: run its build and publish the output folder (the one that contains index.html).');
  return { framework: framework?.name || null, builtOutputs, message: lines.join(' ') };
}

// Walks the folder (symlinks are not followed) and returns what goes in the archive.
export async function collectFiles(root) {
  const files = []; const skipped = [];
  async function walk(rel) {
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.')) { if (!e.isDirectory() && !e.name.startsWith('._') && e.name !== '.DS_Store' && e.name !== '.publish-my.json') skipped.push({ path: relPath, reason: 'hidden file' }); continue; }
      if (e.isSymbolicLink()) { skipped.push({ path: relPath, reason: 'symlink' }); continue; }
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) { skipped.push({ path: relPath + '/', reason: 'dependency folder' }); continue; } await walk(relPath); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) { skipped.push({ path: relPath, reason: 'file type not allowed' }); continue; }
      files.push(relPath);
    }
  }
  await walk('');
  return { files, skipped };
}

// Returns { buffer, fileCount, bytes, skipped }.
export async function packFolder(dir, limits = LIMITS) {
  const root = path.resolve(dir);
  const st = await fs.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new PackError('not_a_folder', `${root} is not a folder.`);
  if (!(await exists(path.join(root, 'index.html')))) {
    const d = await diagnoseMissingIndex(root);
    throw new PackError('no_index', d.message);
  }
  const { files, skipped } = await collectFiles(root);
  if (files.length > limits.maxFiles) throw new PackError('too_many_files', `${files.length} files; the limit is ${limits.maxFiles} per site.`);

  const pack = tarPack();
  const gz = pack.pipe(zlib.createGzip({ level: 9 }));
  const chunks = []; let size = 0;
  const done = new Promise((resolve, reject) => {
    gz.on('data', (c) => { chunks.push(c); size += c.length; });
    gz.on('end', resolve); gz.on('error', reject);
  });
  let bytes = 0;
  for (const rel of files) {
    const data = await fs.readFile(path.join(root, rel));
    bytes += data.length;
    await new Promise((resolve, reject) => pack.entry({ name: rel, size: data.length, mode: 0o644, mtime: new Date(0) }, data, (err) => (err ? reject(err) : resolve())));
  }
  pack.finalize();
  await done;
  if (size > limits.maxTarballBytes) {
    throw new PackError('too_large', `The packed site is ${(size / 1048576).toFixed(1)} MB; the upload limit is ${limits.maxTarballBytes / 1048576} MB. Compress large images (WebP) or videos and try again.`);
  }
  return { buffer: Buffer.concat(chunks, size), fileCount: files.length, bytes, skipped };
}
