import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.mjs';
import { waitForMovementResult } from './receipts.mjs';

const setupMessages = {
  // VoiceOS glance cards show at most 64 characters.
  EVERWHERE_SETUP_REQUIRED: 'Check API URL, Project ID and token in VoiceOS, then reload.',
  EVERWHERE_CONFIG_UNSAFE: 'Keep ~/.config/everwhere/voiceos.json private (chmod 600).',
  EVERWHERE_CONFIG_INVALID: 'Saved VoiceOS setup is invalid. Pair again in Everwhere.'
};

const tools = JSON.parse(readFileSync(new URL('../../packages/contracts/mcp-tools.json', import.meta.url))).tools;
const supported = new Set(tools.map(tool => tool.name));
const server = new Server({ name: 'everwhere', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

function toolResult(value, isError = false) {
  const queued = !isError && value.data?.status === 'queued';
  const summary = isError ? (value.message || 'The request could not be completed.') :
    value.data?.message ? value.data.message :
    queued ? 'Request sent. Waiting for the Everwhere browser.' :
    (value.data?.diff?.label || value.data?.event || value.data?.title || 'Request completed.');
  const result = { ...value, _voiceos_glance: { blocks: [
    { type: 'header', title: 'Everwhere', icon: 'globe', trailing: isError ? 'Needs attention' : value.data?.previewToken ? 'Review change' : queued ? 'Queued' : 'Ready' },
    { type: 'keyValue', pairs: [[isError ? 'Message' : 'Result', String(summary).slice(0, 64)]] }
  ] } };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError };
}

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (!supported.has(params.name)) return toolResult({ ok: false, message: 'Everwhere does not support this tool.' }, true);
  // Read on every call so pairing in the browser takes effect without restarting VoiceOS.
  const config = loadConfig();
  if (config.error) return toolResult({ ok: false, code: config.error, message: setupMessages[config.error] }, true);
  const { api, project, token } = config;
  try {
    const path = '/v1/projects/' + encodeURIComponent(project) + '/voice/' + encodeURIComponent(params.name);
    const response = await fetch(new URL(path, api), {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(params.arguments || {}),
      signal: AbortSignal.timeout(12000)
    });
    let result = await response.json();
    if (params.name === 'move_player' && response.ok && result.ok) {
      result = await waitForMovementResult(result, async signal => {
        const context = await fetch(new URL('/v1/projects/' + encodeURIComponent(project) + '/voice/get_context', api), {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}'
        });
        if (!context.ok) throw new Error('Context unavailable');
        return (await context.json()).data;
      });
    }
    return toolResult(result, !response.ok || !result.ok);
  } catch {
    return toolResult({ ok: false, code: 'EVERWHERE_UNREACHABLE', message: 'Everwhere could not be reached. Check its API origin and connection.' }, true);
  }
});

await server.connect(new StdioServerTransport());
