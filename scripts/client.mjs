// Dev helper: spawn the stdio server and call a tool. Usage:
//   node scripts/client.mjs list
//   node scripts/client.mjs call <tool> '<json args>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [cmd, tool, args] = process.argv.slice(2);
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../src/index.js', import.meta.url).pathname], env: { ...process.env }, stderr: 'inherit' });
const client = new Client({ name: 'pm-test-client', version: '0.0.1' });
await client.connect(transport);
if (cmd === 'list') {
  const t = await client.listTools();
  for (const x of t.tools) console.log(x.name, '-', JSON.stringify(Object.keys(x.inputSchema.properties || {})), JSON.stringify(x.annotations));
} else {
  const r = await client.callTool({ name: tool, arguments: JSON.parse(args || '{}') });
  console.log(JSON.stringify(r, null, 2));
}
await client.close();
