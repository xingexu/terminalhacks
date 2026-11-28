import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { waitForMovementResult } from '../apps/mcp/receipts.mjs';

const command = { id: 'command', worldId: 'world', viewerId: 'viewer', direction: 'turn_right' };
const initial = { ok: true, data: { status: 'queued', command } };
const receipt = { commandId: command.id, worldId: command.worldId, viewerId: command.viewerId, status: 'completed', heading: 66 };

test('movement wait rejects unrelated receipts and waits for the matching browser outcome', async () => {
  let time = 0, calls = 0;
  const result = await waitForMovementResult(initial, async () => ({ movementReceipt: calls++ ? receipt : { ...receipt, viewerId: 'other-tab' } }),
    { now: () => time, delay: async ms => { time += ms; } });
  assert.equal(calls, 2);
  assert.equal(result.data.status, 'completed');
  assert.match(result.data.message, /Turn completed.*66/);
});

test('movement timeout, supersession and failed polling never imply execution', async () => {
  let time = 0;
  const result = await waitForMovementResult(initial, async () => ({}), { timeoutMs: 300, now: () => time, delay: async ms => { time += ms; } });
  assert.equal(result.data.status, 'queued');
  assert.equal(result.data.receipt, undefined);
  assert.match(result.data.message, /no browser result/);
  const replaced = await waitForMovementResult(initial, async () => ({ movement: { id: 'new-command' } }));
  assert.equal(replaced.data.status, 'queued');
  assert.match(replaced.data.message, /newer command/);
  const offline = await waitForMovementResult(initial, async () => { throw new Error('offline'); });
  assert.equal(offline.data.status, 'queued');
  assert.match(offline.data.message, /could not be confirmed/);
});

test('blocked and stopped browser outcomes are returned truthfully', async () => {
  for (const status of ['blocked', 'stopped']) {
    const result = await waitForMovementResult(initial, async () => ({ movementReceipt: { ...receipt, status, reason: 'No next panorama' } }));
    assert.equal(result.data.status, status);
    assert.doesNotMatch(result.data.message, /completed/);
  }
});

test('actual MCP stdio returns the observed turn rather than a queued plan', async t => {
  let polls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the request */ }
    assert.equal(req.headers.authorization, 'Bearer fixture-test-token');
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/move_player')) res.end(JSON.stringify(initial));
    else {
      polls++;
      res.end(JSON.stringify({ ok: true, data: polls < 2 ? { movement: command } : { movement: command, movementReceipt: receipt } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'receipt-test', version: '1.0.0' });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../apps/mcp/index.mjs', import.meta.url))],
    env: { EVERWHERE_API: `http://127.0.0.1:${server.address().port}`, EVERWHERE_PROJECT: 'test-project', EVERWHERE_PAIRING_TOKEN: 'fixture-test-token' } }));
  const result = await client.callTool({ name: 'move_player', arguments: { direction: 'turn_right', degrees: 90 } });
  assert.equal(result.isError, false);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.data.status, 'completed');
  assert.equal(body.data.receipt.heading, 66);
  assert.match(body._voiceos_glance.blocks[1].pairs[0][1], /Turn completed.*66/);
  assert.notEqual(body._voiceos_glance.blocks[0].trailing, 'Queued');
  assert.equal(polls, 2);
});
