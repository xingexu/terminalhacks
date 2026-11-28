import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/api/server.mjs';

test('the sample project opens on Mont-Tremblant with an approved Street View route', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-sample-'));
  const app = await createApp({ dataDir: dir, serveWeb: false, sampleRoute: true });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const root = await app.listen({ port: 0, host: '127.0.0.1' });
  const boot = await fetch(root + '/v1/bootstrap');
  const Cookie = boot.headers.get('set-cookie').split(';')[0];
  const { data: [sample] } = await boot.json();
  assert.equal(sample.title, 'Mont-Tremblant');
  const get = async path => (await fetch(root + '/v1/projects/' + sample.id + path, { headers: { Cookie } }));
  const { data: state } = await (await get('/snapshot')).json();
  assert.deepEqual(state.events.map(event => event.title), ['Place Saint-Bernard', 'Lac Tremblant', 'First light at the summit']);
  const [world] = state.worlds;
  assert.ok(world.approved && world.format === 'tour' && world.tour.liveStreetView);
  assert.equal(state.anchors.filter(anchor => anchor.worldId === world.id).length, 2);
  const tour = await (await get('/worlds/' + world.id + '/tour.json')).json();
  assert.deepEqual(tour.nodes.map(node => node.id), world.tour.nodes.map(node => node.id));
  assert.ok(tour.nodes.every(node => node.projection === 'streetview' && Math.abs(node.streetView.lat - 46.21) < 0.01));
  for (const item of state.media) assert.equal((await get('/sources/' + item.id)).status, 200);
  // A second visit does not add another sample.
  assert.equal((await (await fetch(root + '/v1/bootstrap', { headers: { Cookie } })).json()).data.length, 1);
});
