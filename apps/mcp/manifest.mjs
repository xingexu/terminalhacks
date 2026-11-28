import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];

export function integrationManifest(origin = 'http://127.0.0.1:4173') {
  const api = new URL(origin);
  const loopback = loopbackHosts.includes(api.hostname);
  if (api.username || api.password || !(api.protocol === 'https:' || (loopback && api.protocol === 'http:'))) {
    throw new Error('Use an HTTPS API origin or loopback HTTP.');
  }
  const tools = JSON.parse(readFileSync(new URL('../../packages/contracts/mcp-tools.json', import.meta.url))).tools;
  return {
    schemaVersion: 1,
    id: 'com.everwhere.memories',
    version: '0.2.0',
    name: 'Everwhere',
    summary: 'Find memories, revisit places, and review your stories by voice.',
    publisher: { id: 'everwhere', name: 'Everwhere' },
    repository: 'https://github.com/xingexu/terminalhacks',
    runtime: { kind: 'local-mcp', command: 'node', args: ['apps/mcp/index.mjs'] },
    permissions: [{ kind: 'network', domains: loopback ? loopbackHosts : [api.hostname] }],
    auth: { kind: 'apiKey', fields: [{ key: 'EVERWHERE_PAIRING_TOKEN', label: 'Pairing token from Everwhere → VoiceOS', secret: true, required: true }] },
    preferences: [
      { name: 'EVERWHERE_API', title: 'API origin', type: 'text', default: api.origin, description: 'The address of your running Everwhere server.' },
      { name: 'EVERWHERE_PROJECT', title: 'Project ID', type: 'text', required: true, description: 'Copy the project ID from Everwhere → VoiceOS.' }
    ],
    tools: tools.map(tool => ['confirm_change', 'research_place'].includes(tool.name) ? {
      ...tool,
      confirmation: {
        schemaVersion: 1,
        root: {
          type: 'card', title: tool.name === 'research_place' ? 'Research this place on Wikipedia?' : 'Confirm the reviewed change?',
          children: [{ type: 'text', text: tool.name === 'research_place' ?
            'Send the memory place name or approximate coordinates to Wikipedia. Photos and conversation stay private. Results are background context, not proof of your memory.' :
            'Apply the Everwhere preview you just reviewed. Expired or changed previews must be reviewed again.' }],
          footer: [{ type: 'actions', items: [
            { label: 'Cancel', role: 'cancel' },
            { label: 'Confirm change', role: 'confirm', color: 'accent' }
          ] }]
        }
      }
    } : tool)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../../voiceos.integration.json', import.meta.url), JSON.stringify(integrationManifest(), null, 2) + '\n');
}
