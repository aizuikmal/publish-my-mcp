// Thin client for the publish.my JSON API (https://publish.my/llms.txt). Every call returns
// { status, body } and never throws on an HTTP error; the tools decide what to tell the user.
export const VERSION = '0.1.0';

export function createApi({ baseUrl = process.env.PUBLISHMY_API_URL || 'https://api.publish.my', clientName = () => null, fetchImpl = fetch } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const ua = () => {
    const c = clientName();
    return `publish-my-mcp/${VERSION}${c ? ` (${c})` : ''}`;
  };

  async function call(method, path, { headers = {}, body, timeoutMs = 30_000 } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, { method, headers: { 'User-Agent': ua(), Accept: 'application/json', ...headers }, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : (e.cause?.code || e.message);
      return { status: 0, body: { error: { code: 'network', message: `Could not reach ${base}: ${why}` } } };
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, body: json ?? {}, retryAfter: res.headers.get('retry-after') };
  }

  return {
    base,
    deploy({ tarball, projectId, key, deploySecret }) {
      const form = new FormData();
      form.append('site', new Blob([tarball], { type: 'application/gzip' }), 'site.tar.gz');
      if (projectId) form.append('project_id', projectId);
      const headers = {};
      if (key) headers.Authorization = `Bearer ${key}`;
      else if (deploySecret) headers['X-Deploy-Secret'] = deploySecret;
      return call('POST', '/v1/deploy', { headers, body: form, timeoutMs: 5 * 60_000 }); // uploads up to 50 MB
    },
    exchange(token) { return call('GET', `/v1/agent/exchange/${encodeURIComponent(token)}`); },
    relink(projectId) {
      const form = new FormData(); form.append('project_id', projectId);
      return call('POST', '/v1/agent/relink', { body: form });
    },
    projects(key) { return call('GET', '/v1/projects', { headers: { Authorization: `Bearer ${key}` } }); },
    publicInfo(projectId) { return call('GET', `/v1/projects/${encodeURIComponent(projectId)}/public`); },
  };
}
