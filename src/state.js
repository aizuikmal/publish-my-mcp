// Everything the server persists on the user's machine, in the same places llms.txt tells a
// curl-driven agent to use, so the MCP and the curl path share one key and one breadcrumb:
//   ~/.publishmy                       API key (plain text), mode 600
//   <project>/.publish-my.json         breadcrumb: which publish.my project this folder is
//   ~/.config/publish-my/pending.json  deploy secrets + exchange tokens of not-yet-activated sites
//                                      (kept OUT of the project folder so they are never committed)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEPLOY_URL = 'https://api.publish.my/v1/deploy';
export const INSTRUCTIONS_URL = 'https://publish.my/llms.txt';
const BREADCRUMB = '.publish-my.json';

export function paths(home = os.homedir()) {
  return {
    key: path.join(home, '.publishmy'),
    pendingDir: path.join(home, '.config', 'publish-my'),
    pending: path.join(home, '.config', 'publish-my', 'pending.json'),
  };
}

async function writePrivate(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, text, { mode: 0o600 });
  await fs.chmod(file, 0o600); // writeFile's mode only applies when the file is created
}

// ---- API key ----
export async function readKey({ env = process.env, home } = {}) {
  if (env.PUBLISHMY_API_KEY) return env.PUBLISHMY_API_KEY.trim();
  try { return (await fs.readFile(paths(home).key, 'utf8')).trim() || null; } catch { return null; }
}
export async function saveKey(key, { home } = {}) {
  await writePrivate(paths(home).key, key.trim() + '\n');
}

// ---- pending (staged, not yet activated) ----
export async function readPending({ home } = {}) {
  try { return JSON.parse(await fs.readFile(paths(home).pending, 'utf8')); } catch { return {}; }
}
export async function setPending(projectId, value, { home } = {}) {
  const all = await readPending({ home });
  if (value) all[projectId] = value; else delete all[projectId];
  await writePrivate(paths(home).pending, JSON.stringify(all, null, 2) + '\n');
}

// ---- breadcrumb ----
// The project root is the nearest ancestor (or the folder itself) holding .git or package.json,
// never above the home directory. A site built into dist/ keeps its breadcrumb at the project root.
export async function projectRoot(siteDir, { home = os.homedir() } = {}) {
  let dir = path.resolve(siteDir);
  const stop = path.resolve(home);
  for (;;) {
    for (const marker of ['.git', 'package.json']) {
      try { await fs.stat(path.join(dir, marker)); return dir; } catch { /* keep looking */ }
    }
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir || !dir.startsWith(stop + path.sep)) return path.resolve(siteDir);
    dir = parent;
  }
}

const rel = (from, to) => path.relative(from, to) || '.';

// Finds the breadcrumb that belongs to siteDir: one in siteDir itself, or one at the project root
// whose site_path points at siteDir. A breadcrumb written by the curl flow has no site_path; at the
// project root is only trusted for the root folder itself (see below).
export async function findBreadcrumb(siteDir, opts = {}) {
  const site = path.resolve(siteDir);
  const root = await projectRoot(site, opts);
  for (const dir of [...new Set([site, root])]) {
    const file = path.join(dir, BREADCRUMB);
    let data;
    try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    if (!data || typeof data.project_id !== 'string') continue;
    // No site_path (written by the curl flow): it only identifies the folder it sits in, since
    // nothing says which subfolder that flow packed. Guessing could overwrite a different site.
    if ((data.site_path || '.') !== rel(dir, site)) continue;
    return { file, dir, data };
  }
  return null;
}

// Writes (or refreshes) the breadcrumb in the full llms.txt shape plus site_path.
export async function writeBreadcrumb(siteDir, { projectId, url }, opts = {}) {
  const site = path.resolve(siteDir);
  const found = await findBreadcrumb(site, opts);
  let dir;
  if (found && found.data.project_id === projectId) dir = found.dir;
  else {
    const root = await projectRoot(site, opts);
    // Do not clobber another site's breadcrumb at the project root.
    const atRoot = await fs.readFile(path.join(root, BREADCRUMB), 'utf8').then(JSON.parse, () => null);
    dir = atRoot && atRoot.project_id !== projectId ? site : root;
  }
  const data = {
    service: 'publish.my', project_id: projectId, url,
    deploy: DEPLOY_URL, instructions: INSTRUCTIONS_URL, site_path: rel(dir, site),
  };
  const file = path.join(dir, BREADCRUMB);
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}
