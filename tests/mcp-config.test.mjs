import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../apps/api/server.mjs';
import { loadConfig } from '../apps/mcp/config.mjs';

const saved = { api: 'http://127.0.0.1:4173', project: 'p-test', token: 'disposable-test-token' };

async function home(t, content = saved, { fileMode = 0o600, dirMode = 0o700 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'everwhere-mcp-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '.config', 'everwhere');
  await mkdir(dir, { recursive: true });
  await chmod(dir, dirMode);
  const file = join(dir, 'voiceos.json');
  if (content !== null) {
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
    await chmod(file, fileMode);
  }
  return { root, dir, file };
}

const code = result => result.error;

test('a private config file pairs VoiceOS when no environment setup exists', async t => {
  const { file } = await home(t);
  const config = loadConfig({ env: {}, file });
  assert.equal(config.api.origin, 'http://127.0.0.1:4173');
  assert.equal(config.project, 'p-test');
  assert.equal(config.token, 'disposable-test-token');
  const { file: remote } = await home(t, { api: 'https://everwhere.example.com', project: 'p', token: 't' });
  assert.equal(loadConfig({ env: {}, file: remote }).api.origin, 'https://everwhere.example.com');
  const { file: defaulted } = await home(t, { project: 'p', token: 't' });
  assert.equal(loadConfig({ env: {}, file: defaulted }).api.origin, 'http://127.0.0.1:4173');
});

test('any environment setup takes precedence and is never mixed with the file', async t => {
  const { file } = await home(t);
  const env = { EVERWHERE_API: 'https://env.example.com', EVERWHERE_PROJECT: 'p-env', EVERWHERE_PAIRING_TOKEN: 'env-token' };
  const config = loadConfig({ env, file });
  assert.deepEqual([config.api.origin, config.project, config.token], ['https://env.example.com', 'p-env', 'env-token']);
  assert.equal(code(loadConfig({ env: { EVERWHERE_PROJECT: '' }, file })), 'EVERWHERE_SETUP_REQUIRED');
  assert.equal(code(loadConfig({ env: { EVERWHERE_API: 'https://env.example.com' }, file })), 'EVERWHERE_SETUP_REQUIRED');
  const { file: unsafeFile } = await home(t, saved, { fileMode: 0o644 });
  assert.equal(loadConfig({ env, file: unsafeFile }).token, 'env-token');
});

test('a missing config folder or file asks for setup', async t => {
  const { root, file } = await home(t, null);
  assert.equal(code(loadConfig({ env: {}, file })), 'EVERWHERE_SETUP_REQUIRED');
  assert.equal(code(loadConfig({ env: {}, file: join(root, 'absent', 'voiceos.json') })), 'EVERWHERE_SETUP_REQUIRED');
  assert.equal(code(loadConfig({ env: {}, file, uid: undefined })), 'EVERWHERE_SETUP_REQUIRED');
});

test('shared permissions, other owners, links and special files are refused', async t => {
  for (const fileMode of [0o644, 0o640, 0o604, 0o660]) {
    const { file } = await home(t, saved, { fileMode });
    assert.equal(code(loadConfig({ env: {}, file })), 'EVERWHERE_CONFIG_UNSAFE', fileMode.toString(8));
  }
  for (const dirMode of [0o770, 0o707, 0o777]) {
    const { file } = await home(t, saved, { dirMode });
    assert.equal(code(loadConfig({ env: {}, file })), 'EVERWHERE_CONFIG_UNSAFE', dirMode.toString(8));
  }
  const { file } = await home(t);
  assert.equal(code(loadConfig({ env: {}, file, uid: process.getuid() + 1 })), 'EVERWHERE_CONFIG_UNSAFE');
  const linked = await home(t, null);
  await symlink(file, linked.file);
  assert.equal(code(loadConfig({ env: {}, file: linked.file })), 'EVERWHERE_CONFIG_UNSAFE');
  const linkedFolder = await home(t, null);
  await rm(linkedFolder.dir, { recursive: true });
  await symlink(join(file, '..'), linkedFolder.dir);
  assert.equal(code(loadConfig({ env: {}, file: linkedFolder.file })), 'EVERWHERE_CONFIG_UNSAFE');
  const folder = await home(t, null);
  await mkdir(folder.file, { mode: 0o700 });
  assert.equal(code(loadConfig({ env: {}, file: folder.file })), 'EVERWHERE_CONFIG_UNSAFE');
  const fifo = await home(t, null);
  execFileSync('mkfifo', ['-m', '600', fifo.file]);
  assert.equal(code(loadConfig({ env: {}, file: fifo.file })), 'EVERWHERE_CONFIG_UNSAFE', 'A FIFO is refused without blocking');
});

test('invalid content and unsafe origins are refused without echoing the token', async t => {
  const cases = [
    '{"token": "disposable-test-token"',
    'x'.repeat(5000),
    JSON.stringify([saved]),
    JSON.stringify({ ...saved, extra: true }),
    '{"__proto__": {}, "project": "p-test", "token": "disposable-test-token"}',
    JSON.stringify({ ...saved, token: 42 }),
    JSON.stringify({ ...saved, token: '' }),
    JSON.stringify({ ...saved, project: '' }),
    JSON.stringify({ ...saved, token: 'disposable-test-token\r\nX-Injected: yes' }),
    JSON.stringify({ ...saved, api: 'http://everwhere.example.com' }),
    JSON.stringify({ ...saved, api: 'https://user:disposable-test-token@everwhere.example.com' }),
    JSON.stringify({ ...saved, api: 'file:///tmp/everwhere' }),
    JSON.stringify({ ...saved, api: 'not a URL' })
  ];
  for (const content of cases) {
    const { file } = await home(t, content);
    const result = loadConfig({ env: {}, file });
    assert.deepEqual(result, { error: 'EVERWHERE_CONFIG_INVALID' }, content.slice(0, 80));
  }
});

test('MCP stdio reads the private config on each call without a restart or leaking the token', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'everwhere-mcp-config-api-'));
  const app = await createApp({ dataDir, serveWeb: false });
  let requests = 0;
  app.addHook('onRequest', async () => { requests++; });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const root = await app.listen({ port: 0, host: '127.0.0.1' });
  const boot = await fetch(root + '/v1/bootstrap');
  const cookie = boot.headers.get('set-cookie').split(';')[0];
  const { data: [demo] } = await boot.json();
  const pairing = await fetch(root + '/v1/projects/' + demo.id + '/pairing', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
  const { data: { token } } = await pairing.json();
  const { root: fakeHome, file } = await home(t, null);
  const client = new Client({ name: 'everwhere-config-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../apps/mcp/index.mjs', import.meta.url))], env: { HOME: fakeHome } }));
  try {
    async function call() {
      const result = await client.callTool({ name: 'get_context', arguments: {} });
      assert.equal(JSON.stringify(result).includes(token), false, 'Tool results never contain the token');
      return { isError: result.isError, data: JSON.parse(result.content[0].text) };
    }
    const baseline = requests;
    assert.equal((await call()).data.code, 'EVERWHERE_SETUP_REQUIRED');
    assert.equal(requests, baseline, 'No API request without setup');
    await writeFile(file, JSON.stringify({ api: root, project: demo.id, token }), { mode: 0o600 });
    const paired = await call();
    assert.equal(paired.isError, false);
    assert.equal(paired.data.data.event, 'Lago di Braies');
    await chmod(file, 0o644);
    const before = requests;
    const unsafe = await call();
    assert.equal(unsafe.data.code, 'EVERWHERE_CONFIG_UNSAFE');
    assert.equal(unsafe.data._voiceos_glance.blocks[1].pairs[0][1], unsafe.data.message);
    assert.equal(requests, before, 'An unsafe file never sends its token');
  } finally { await client.close(); }
});
