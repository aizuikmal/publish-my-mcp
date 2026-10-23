// Tool behaviour, kept free of MCP plumbing so tests can drive it directly.
// Each handler returns { text, data, isError? }; index.js turns that into an MCP result.
import path from 'node:path';
import { packFolder, PackError } from './pack.js';
import * as state from './state.js';

const CONSOLE_URL = 'https://console.publish.my';
const BAD_ID = (id) => ({ isError: true, text: `${JSON.stringify(clean(id, 40))} is not a publish.my site id (it looks like 88 followed by 8 letters/digits).`, data: { error: 'bad_project_id' } });

// Text that comes from the user's folder (file names) or the server goes back to the model, so
// strip control/format characters, cap the length, and quote file names: they are data.
const clean = (s, max = 200) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').slice(0, max);
const quoted = (s) => JSON.stringify(clean(s, 120));

function apiError(r, { projectId } = {}) {
  const code = clean(r.body?.error?.code || `http_${r.status}`, 60);
  const message = clean(r.body?.error?.message || 'unexpected response');
  if (r.status === 0) return message;
  if (r.status === 429) return `publish.my is rate-limiting this request. Wait ${r.retryAfter || 'a few'} seconds and try again.`;
  if (code === 'storage_limit_reached') return 'This account is out of storage (500 MB free). Delete an old site at https://console.publish.my, then publish again.';
  if ((r.status === 401 || r.status === 403) && projectId) {
    return `publish.my refused the update to ${projectId} (${code}: ${message}). If this is the user's site and the key was lost, call reconnect_site.`;
  }
  const paths = Array.isArray(r.body?.paths) && r.body.paths.length ? ` Files: ${r.body.paths.slice(0, 20).map(quoted).join(', ')}` : '';
  return `${code}: ${message}${paths}`;
}

const fmtSkipped = (skipped) => skipped.length
  ? `Left out ${skipped.length} file(s): ${skipped.slice(0, 15).map((s) => `${quoted(s.path)} (${s.reason})`).join(', ')}${skipped.length > 15 ? ', …' : ''}.`
  : '';

export function createTools({ api, home, env = process.env, pollIntervalMs = 10_000, pollTimeoutMs = 30 * 60_000, log = () => {} }) {
  const opts = { home, env };
  const watchers = new Map(); // projectId -> timer

  // Decides where a freshly issued key goes. ~/.publishmy is only (re)written when it is empty or
  // its key is dead. If it already holds a working key for a DIFFERENT account (say the site was
  // claimed or relinked by someone else's email), that key is kept and the new one is stored for
  // this site only, so one activation can never silently switch the machine's account.
  async function storeKey(projectId, newKey) {
    const active = await state.readKey(opts);
    if (!active || active === newKey) { await state.saveKey(newKey, opts); return 'live'; }
    const cur = await api.me(active);
    if (cur.status === 401 && !env.PUBLISHMY_API_KEY) { await state.saveKey(newKey, opts); return 'live'; }
    if (cur.status === 200) {
      const next = await api.me(newKey);
      if (next.status === 200 && next.body?.email && next.body.email === cur.body?.email) return 'live'; // same account: keep the existing key
    }
    await state.saveSiteKey(projectId, newKey, opts);
    return 'other_account';
  }

  // One exchange poll. Saves the key on success. Returns 'live' | 'other_account' | 'pending' | 'expired' | 'error' | 'unsaved'.
  async function pollOnce(projectId, token) {
    const r = await api.exchange(token);
    if (r.status === 200 && r.body.api_key) {
      // The server hands the key out once: if it can't be saved, say so rather than lose it quietly.
      let s;
      try { s = await storeKey(projectId, r.body.api_key); } catch (e) {
        stopWatching(projectId);
        log(`publish.my: ${projectId} activated, but saving its key failed: ${e.message}`);
        return 'unsaved';
      }
      await state.setPending(projectId, null, opts).catch(() => {});
      stopWatching(projectId);
      log(`publish.my: ${projectId} activated; ${s === 'live' ? 'API key in ~/.publishmy' : 'key for a different account saved under ~/.config/publish-my/keys/'}`);
      return s;
    }
    if (r.status === 202) return 'pending';
    if (r.status === 410 || r.status === 404) {
      await state.setPending(projectId, null, opts);
      stopWatching(projectId);
      // 410 'gone' means another process already picked the key up.
      return (await state.readKey(opts)) ? 'live' : 'expired';
    }
    return 'error';
  }

  function stopWatching(projectId) {
    const t = watchers.get(projectId);
    if (t) { clearInterval(t); watchers.delete(projectId); }
  }
  function watch(projectId, token) {
    stopWatching(projectId);
    const started = Date.now();
    let inFlight = false;
    const t = setInterval(async () => {
      if (Date.now() - started > pollTimeoutMs) return stopWatching(projectId);
      if (inFlight) return;
      inFlight = true;
      try { await pollOnce(projectId, token); } catch (e) { log(`publish.my: poll failed: ${e.message}`); } finally { inFlight = false; }
    }, pollIntervalMs);
    t.unref?.();
    watchers.set(projectId, t);
  }

  const keyFor = async (projectId) => (projectId && await state.readSiteKey(projectId, opts)) || state.readKey(opts);

  async function publishSite({ path: sitePath, project_id: projectIdArg, confirm_update: confirm = false, new_site: forceNew = false }) {
    if (projectIdArg && !state.isProjectId(projectIdArg)) return BAD_ID(projectIdArg);
    const site = path.resolve(sitePath);
    let packed;
    try { packed = await packFolder(site); } catch (e) {
      if (e instanceof PackError) return { isError: true, text: e.message, data: { error: e.code } };
      throw e;
    }

    const crumb = forceNew ? null : await state.findBreadcrumb(site, opts);
    let projectId = projectIdArg || crumb?.data.project_id || null;
    const pending = projectId ? (await state.readPending(opts))[projectId] : null;

    let staleNote = ''; let staged = false;
    if (projectId) {
      const info = await api.publicInfo(projectId);
      if (info.status !== 200 && info.status !== 404) {
        // Can't tell whether the site is live, so don't risk replacing it unasked.
        return { isError: true, text: `Couldn't check the current state of ${projectId} (${apiError(info)}). Nothing was uploaded; try again in a moment.`, data: { error: 'status_unknown', project_id: projectId } };
      }
      if (info.status === 404) {
        // Purged (unactivated sites expire) or deleted: publish as a new site instead.
        staleNote = `The earlier site ${projectId} no longer exists, so this was published as a new site. `;
        if (pending) await state.setPending(projectId, null, opts);
        projectId = null;
      } else if (info.body.status === 'staged') {
        staged = true;
      } else if (!confirm) {
        return {
          text: `This folder is already published at https://${projectId}.publish.my (live). Publishing again replaces the live site at the same address. Ask the user to confirm, then call publish_site again with confirm_update: true. (To publish it as a separate new site instead, pass new_site: true.)`,
          data: { status: 'needs_confirmation', project_id: projectId, url: `https://${projectId}.publish.my` },
        };
      }
    }
    // A staged site has no owner yet: only its deploy secret can update it, even if a key exists.
    if (projectId && staged && !pending?.deploy_secret) {
      return {
        isError: true,
        text: `${projectId} is still waiting for activation, and this machine doesn't hold its deploy secret. Ask the user to open https://${projectId}.publish.my and confirm their email (then publish again), or publish this folder as a new site with new_site: true.`,
        data: { error: 'staged_no_secret', project_id: projectId },
      };
    }
    const key = await keyFor(projectId);
    if (projectId && !staged && !key) {
      return {
        isError: true,
        text: `${projectId} belongs to an activated publish.my account, but this machine has no publish.my key (~/.publishmy). Call reconnect_site with project_id "${projectId}" — the owner gets a confirm email, then updates work again.`,
        data: { error: 'no_key', project_id: projectId },
      };
    }

    const useSecret = projectId && staged;
    const r = await api.deploy({ tarball: packed.buffer, projectId, key: useSecret ? null : key, deploySecret: useSecret ? pending.deploy_secret : null });
    if (r.status >= 300 || r.status === 0) return { isError: true, text: apiError(r, { projectId }), data: { error: r.body?.error?.code || 'deploy_failed', status: r.status } };

    const b = r.body;
    // The deploy succeeded: record what's needed to finish activation BEFORE anything else can fail.
    if (b.status === 'staged' && b.deploy_secret && b.agent_exchange_token) {
      await state.setPending(b.project_id, { url: b.url, deploy_secret: b.deploy_secret, agent_exchange_token: b.agent_exchange_token, expires_at: b.expires_at, created_at: new Date().toISOString() }, opts);
      watch(b.project_id, b.agent_exchange_token);
    }
    let breadcrumb = null, crumbWarn = '';
    try { breadcrumb = await state.writeBreadcrumb(site, { projectId: b.project_id, url: b.url }, opts); } catch (e) {
      crumbWarn = `\n\nCouldn't write .publish-my.json (${e.code || e.message}); to update this site later, pass project_id "${b.project_id}".`;
    }
    const serverWarn = Array.isArray(b.warnings) && b.warnings.length ? ` Server notes: ${b.warnings.slice(0, 10).map((w) => clean(w)).join('; ')}.` : '';
    const skipped = fmtSkipped(packed.skipped);
    const data = { status: b.status, project_id: b.project_id, url: b.url, files: packed.fileCount, breadcrumb, skipped: packed.skipped, warnings: b.warnings || [] };

    if (b.status === 'staged') {
      return {
        data,
        text: `${staleNote}Deployed ${packed.fileCount} file(s) to ${b.url} — not public yet.\n\nTell the user, in friendly words: "Your site is deployed! Open ${b.url} — you'll see a preview. Enter your email there and click the confirmation link we send you, and the site goes live at this same address."\n\nI'm watching for the activation in the background and will save the publish.my key to ~/.publishmy when it happens, so later updates need no email. If the user says they've confirmed, call check_activation.${skipped ? `\n\n${skipped}` : ''}${serverWarn}${crumbWarn}`,
      };
    }
    return {
      data,
      text: `${staleNote}Published ${packed.fileCount} file(s). Live at ${b.url}${b.protected ? ' (password-protected: username "visitor", the owner set the password in the console)' : ''}. Give the user the link.${skipped ? `\n\n${skipped}` : ''}${serverWarn}${crumbWarn}`,
    };
  }

  async function checkActivation({ project_id: only } = {}) {
    if (only && !state.isProjectId(only)) return BAD_ID(only);
    const pending = await state.readPending(opts);
    const ids = only ? [only] : Object.keys(pending);
    if (!ids.length) {
      const key = await state.readKey(opts);
      return { text: key ? 'Nothing is waiting for activation. A publish.my key is saved, so publishes go live immediately.' : 'Nothing is waiting for activation.', data: { results: [] } };
    }
    const results = [];
    for (const id of ids) {
      const p = pending[id];
      if (!p) { results.push({ project_id: id, status: (await state.readKey(opts)) ? 'live' : 'unknown' }); continue; }
      let s; try { s = await pollOnce(id, p.agent_exchange_token); } catch { s = 'error'; }
      results.push({ project_id: id, url: p.url, status: s });
    }
    const line = (x) => ({
      live: `${x.project_id}: activated — live at ${x.url || `https://${x.project_id}.publish.my`}. Key saved to ~/.publishmy.`,
      other_account: `${x.project_id}: activated — live at ${x.url || `https://${x.project_id}.publish.my`}, but on a DIFFERENT publish.my account than the key already on this machine. Kept the existing key in ~/.publishmy; this site's key was saved to ~/.config/publish-my/keys/${x.project_id} and is used only for updates to this site. Tell the user, in case they didn't expect another account.`,
      pending: `${x.project_id}: still waiting. The user needs to open ${x.url}, enter their email, and click the link in the email from publish.my (check spam).`,
      expired: `${x.project_id}: the activation window passed. If the user did activate, their key is at ${CONSOLE_URL}; otherwise publish again.`,
      unknown: `${x.project_id}: no pending activation recorded on this machine.`,
      error: `${x.project_id}: could not check right now; try again shortly.`,
      unsaved: `${x.project_id}: activated and live, but the key could not be saved to ~/.publishmy. The user can create a key at ${CONSOLE_URL} → API keys and save it there.`,
    }[x.status]);
    return { text: results.map(line).join('\n'), data: { results } };
  }

  async function listSites() {
    const key = await state.readKey(opts);
    if (!key) return { isError: true, text: 'No publish.my key on this machine yet. Publish a site first (the key is saved when the user activates it), or the user can create one at https://console.publish.my → API keys and save it to ~/.publishmy.', data: { error: 'no_key' } };
    const r = await api.projects(key);
    if (r.status !== 200) return { isError: true, text: apiError(r), data: { error: r.body?.error?.code || 'list_failed' } };
    const sites = Array.isArray(r.body) ? r.body : [];
    if (!sites.length) return { text: 'This account has no sites yet.', data: { sites } };
    const rows = sites.map((s) => `${s.url}  ${s.status}  ${s.hits_30d ?? 0} views/30d  last deploy ${s.last_deploy_at || '-'}`);
    return { text: `${sites.length} site(s):\n${rows.join('\n')}`, data: { sites } };
  }

  async function reconnectSite({ project_id: projectIdArg, path: sitePath }) {
    if (projectIdArg && !state.isProjectId(projectIdArg)) return BAD_ID(projectIdArg);
    let projectId = projectIdArg;
    if (!projectId && sitePath) projectId = (await state.findBreadcrumb(path.resolve(sitePath), opts))?.data.project_id;
    if (!projectId) return { isError: true, text: 'Which site? Pass project_id (the part before .publish.my) or the path of a published folder.', data: { error: 'no_project' } };
    const r = await api.relink(projectId);
    if (r.status !== 202) return { isError: true, text: apiError(r), data: { error: r.body?.error?.code || 'relink_failed' } };
    await state.setPending(projectId, { url: `https://${projectId}.publish.my`, agent_exchange_token: r.body.agent_exchange_token, expires_at: r.body.expires_at, relink: true, created_at: new Date().toISOString() }, opts);
    watch(projectId, r.body.agent_exchange_token);
    return {
      text: `Tell the user: "To let me update your site, open the email from publish.my and click the confirm link." I'm watching in the background and will save the key when they do; call check_activation to check sooner.`,
      data: { status: 'pending', project_id: projectId },
    };
  }

  return { publishSite, checkActivation, listSites, reconnectSite, _watchers: watchers, stopAll: () => [...watchers.keys()].forEach(stopWatching) };
}
