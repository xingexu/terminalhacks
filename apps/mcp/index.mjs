import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const api = new URL(process.env.EVERWHERE_API || 'http://127.0.0.1:4173');
const project = process.env.EVERWHERE_PROJECT;
const token = process.env.EVERWHERE_PAIRING_TOKEN;
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname);
if (!project || !token || api.username || api.password || !(api.protocol === 'https:' || (loopback && api.protocol === 'http:'))) {
  console.error('Set EVERWHERE_PROJECT, EVERWHERE_PAIRING_TOKEN, and an HTTPS EVERWHERE_API origin (loopback HTTP is supported).');
  process.exit(1);
}

const tools = JSON.parse(readFileSync(new URL('../../packages/contracts/mcp-tools.json', import.meta.url))).tools;
const supported = new Set(tools.map(tool => tool.name));
const server = new Server({ name: 'everwhere', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

function toolResult(value, isError = false) {
  const summary = isError ? (value.message || 'The request could not be completed.') :
    (value.data?.diff?.label || value.data?.event || value.data?.title || 'Request completed.');
  const result = { ...value, _voiceos_glance: { blocks: [
    { type: 'header', title: 'Everwhere', icon: 'globe', trailing: isError ? 'Needs attention' : value.data?.previewToken ? 'Review change' : 'Ready' },
    { type: 'keyValue', pairs: [[isError ? 'Message' : 'Result', String(summary).slice(0, 64)]] }
  ] } };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError };
}

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (!supported.has(params.name)) return toolResult({ ok: false, message: 'Everwhere does not support this tool.' }, true);
  try {
    const path = '/v1/projects/' + encodeURIComponent(project) + '/voice/' + encodeURIComponent(params.name);
    const response = await fetch(new URL(path, api), {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(params.arguments || {}),
      // Pulling photos exports them from the library first, which takes longer than a lookup.
      signal: AbortSignal.timeout(params.name === 'pull_event_photos' ? 180000 : 12000)
    });
    const result = await response.json();
    return toolResult(result, !response.ok || !result.ok);
  } catch {
    return toolResult({ ok: false, code: 'EVERWHERE_UNREACHABLE', message: 'Everwhere could not be reached. Check its API origin and connection.' }, true);
  }
});

await server.connect(new StdioServerTransport());
