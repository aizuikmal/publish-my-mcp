# publish-my

MCP server for [publish.my](https://publish.my): your AI agent publishes a folder as a live
website at `https://<id>.publish.my`. Free, and no account needed to start.

Ask your agent to "put this online" and it calls `publish_site`. The first publish gives a
preview link; the user enters their email on that page once and the site goes live at the same
address. After that, every publish goes live immediately.

## Install

**Claude Code**

```sh
claude mcp add publish-my -- npx -y publish-my
```

**Cursor**: add this to `~/.cursor/mcp.json`

```json
{ "mcpServers": { "publish-my": { "command": "npx", "args": ["-y", "publish-my"] } } }
```

**VS Code**

```sh
code --add-mcp '{"name":"publish-my","command":"npx","args":["-y","publish-my"]}'
```

**Codex**

```sh
codex mcp add publish-my -- npx -y publish-my
```

**Claude Desktop, Windsurf and other MCP clients**: a stdio server running `npx -y publish-my`
(Node 20 or newer).

**claude.ai and ChatGPT** have no filesystem, so they use the remote connector instead: add a
custom connector with the URL `https://api.publish.my/mcp` and sign in to publish.my once.

## Tools

| Tool | What it does |
|---|---|
| `publish_site` | Packs a folder (with `index.html` at its top) and publishes it. Updating a live site needs `confirm_update: true`, which the agent sets after asking the user. |
| `check_activation` | Checks whether the user has confirmed their email for a new site. |
| `list_sites` | Lists the user's sites with status and 30-day views. |
| `reconnect_site` | Recovers access to a live site after the key on this machine was lost. |

There is no delete tool. Sites are deleted in the [console](https://console.publish.my).

## What it stores

The same files the [curl flow](https://publish.my/llms.txt) uses, so the two stay interchangeable:

- `~/.publishmy`: your publish.my API key (mode 600), saved when you activate your first site.
- `<project>/.publish-my.json`: which publish.my site this folder is, so "publish again" updates
  the same address.
- `~/.config/publish-my/pending.json` (mode 600): secrets for sites waiting for activation. It
  is kept out of the project folder so it never ends up in git.

Hidden files (`.env` and similar), `node_modules` and file types publish.my does not host are left
out of the upload. The tool reports what it left out.

Environment overrides: `PUBLISHMY_API_KEY`, and `PUBLISHMY_API_URL` for testing.

## Limits (free)

500 MB per account, unlimited sites, 50 MB per upload, 2,000 files per site, static files only.
Framework apps (Next.js, Vite, Astro, SvelteKit, Nuxt) must be built first; publish the output
folder. Full details: https://publish.my/agents/

## Development

```sh
npm test                    # unit tests
./scripts/e2e-dev.sh        # full flow against a local publish.my DEV server (needs the app repo)
node scripts/client.mjs list
```
