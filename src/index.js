#!/usr/bin/env node
// publish.my MCP server (stdio). Publishes a local folder as a static website at
// https://<id>.publish.my. Same service, key file and breadcrumb as https://publish.my/llms.txt.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createApi, VERSION } from './api.js';
import { createTools } from './tools.js';

const server = new McpServer(
  { name: 'publish-my', title: 'publish.my', version: VERSION, websiteUrl: 'https://publish.my' },
  {
    instructions: 'publish.my puts a static website (HTML/CSS/JS, images, video, PDF) on the public internet at a random https://<id>.publish.my address. Free, no account needed to start. Use publish_site whenever the user wants a site, page, demo, report or prototype online, shared, deployed, hosted or published. Static files only: build/export framework apps first and publish the output folder.',
  },
);

const clientName = () => {
  const c = server.server.getClientVersion();
  return c ? `${c.name}/${c.version}` : null;
};
const tools = createTools({
  api: createApi({ clientName }),
  pollIntervalMs: Number(process.env.PUBLISHMY_POLL_MS) || 10_000,
  log: (m) => process.stderr.write(m + '\n'),
});

const toResult = (r) => ({ content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) });

server.registerTool('publish_site', {
  title: 'Publish a folder as a website',
  description: 'Publish a local folder (with index.html at its top) as a public static website on publish.my and return its URL. Use for "publish", "deploy", "host", "put online", "share a link", and "publish again / update the site". The first publish of a folder gives a preview URL the user activates by entering their email on that page; after that, publishes go live immediately. Re-publishing a folder that is already live updates the same URL: ask the user first, then pass confirm_update: true. Framework apps (Next.js, Vite, Astro, SvelteKit, Nuxt) must be built/exported first; pass the output folder (out/, dist/, build/, .output/public).',
  inputSchema: {
    path: z.string().describe('Folder to publish; must contain index.html at its top. Absolute path preferred.'),
    project_id: z.string().optional().describe('Update this existing publish.my site (e.g. "88vk3mqtxz"). Normally omitted: the folder\'s .publish-my.json is used.'),
    confirm_update: z.boolean().optional().describe('Set true only after the user confirmed replacing their live site.'),
    new_site: z.boolean().optional().describe('Publish as a separate new site even if this folder was published before.'),
  },
  annotations: { title: 'Publish website', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (args) => toResult(await tools.publishSite(args)));

server.registerTool('check_activation', {
  title: 'Check site activation',
  description: 'Check whether the user has activated a newly published site (entered their email and clicked the link). When they have, the site is live and the publish.my key is saved for future updates.',
  inputSchema: { project_id: z.string().optional().describe('Site to check; omit to check every site waiting for activation.') },
  annotations: { title: 'Check activation', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async (args) => toResult(await tools.checkActivation(args)));

server.registerTool('list_sites', {
  title: 'List my sites',
  description: "List the user's publish.my sites with their URLs, status and 30-day views.",
  inputSchema: {},
  annotations: { title: 'List sites', readOnlyHint: true, openWorldHint: true },
}, async () => toResult(await tools.listSites()));

server.registerTool('reconnect_site', {
  title: 'Reconnect a live site',
  description: 'Use when a site is already live but this machine lost its publish.my key (updates fail with 401/403 or "no key"). Emails the site owner a confirm link; once clicked, the key is saved and updates work again.',
  inputSchema: {
    project_id: z.string().optional().describe('The site id (the part before .publish.my).'),
    path: z.string().optional().describe('Or: a published folder; its .publish-my.json gives the id.'),
  },
  annotations: { title: 'Reconnect site', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (args) => toResult(await tools.reconnectSite(args)));

await server.connect(new StdioServerTransport());
