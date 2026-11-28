import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createApp } from '../apps/api/server.mjs';
import { createPhotoLibrary, findEvent } from '../packages/media/photos.mjs';

const picture = seed => sharp({ create: { width: 96, height: 64, channels: 3, background: { r: seed * 40 % 255, g: seed * 90 % 255, b: seed * 17 % 255 } } }).jpeg().toBuffer();

async function setup(t, events = { 'Cottage Weekend': 3, 'Lake Trip': 2, 'Lake House': 1 }) {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-photos-test-'));
  const library = join(dir, 'library');
  let seed = 1;
  for (const [name, count] of Object.entries(events)) {
    await mkdir(join(library, name), { recursive: true });
    for (let index = 0; index < count; index++) await writeFile(join(library, name, 'IMG_' + index + '.jpg'), await picture(seed++));
  }
  await writeFile(join(library, 'Cottage Weekend', 'notes.txt'), 'not a picture');
  const app = await createApp({ dataDir: join(dir, 'data'), serveWeb: false, photoLibrary: createPhotoLibrary({ folder: library }) });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const root = await app.listen({ port: 0, host: '127.0.0.1' });
  const boot = await fetch(root + '/v1/bootstrap');
  const cookie = boot.headers.get('set-cookie').split(';')[0];
  const send = async (path, body, headers, status = 200) => {
    const reply = await fetch(root + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(body !== undefined && { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await reply.json();
    assert.equal(reply.status, status, JSON.stringify(json));
    return status >= 400 ? json : json.data;
  };
  const browser = (path, body, status) => send(path, body, { Cookie: cookie }, status);
  const project = await browser('/v1/projects', { title: 'My memories' }, 201);
  const p = '/v1/projects/' + project.id;
  const { token } = await browser(p + '/pairing', { confirm: true });
  const voice = (tool, input = {}, status) => send(p + '/voice/' + tool, input, { Authorization: 'Bearer ' + token }, status);
  return { p, browser, voice };
}

test('VoiceOS cannot read the photo library until the person allows it in the browser', async t => {
  const { p, browser, voice } = await setup(t);
  assert.equal((await voice('list_photo_events', {}, 403)).code, 'PHOTO_LIBRARY_OFF');
  assert.equal((await voice('pull_event_photos', { event: 'Cottage Weekend' }, 403)).code, 'PHOTO_LIBRARY_OFF');
  assert.equal((await voice('open_immersive_album', {}, 409)).code, 'NO_PHOTOS');
  assert.deepEqual(await browser(p + '/photo-library'), { allowed: false, source: 'folder', events: [] });
  const status = await browser(p + '/photo-library/access', { allow: true });
  assert.deepEqual(status.events.map(item => [item.name, item.count]), [['Cottage Weekend', 3], ['Lake House', 1], ['Lake Trip', 2]]);
  assert.equal((await voice('list_photo_events')).events.length, 3);
  await browser(p + '/photo-library/access', { allow: false });
  assert.equal((await voice('list_photo_events', {}, 403)).code, 'PHOTO_LIBRARY_OFF');
});

test('pulling an event makes a memory from its photos and VoiceOS can open the walk', async t => {
  const { p, browser, voice } = await setup(t);
  await browser(p + '/photo-library/access', { allow: true });
  assert.equal((await voice('pull_event_photos', { event: 'lake' }, 404)).code, 'EVENT_NOT_FOUND');
  assert.equal((await voice('pull_event_photos', { event: 'the birthday' }, 404)).code, 'EVENT_NOT_FOUND');
  const pulled = await voice('pull_event_photos', { event: 'the cottage weekend photos' });
  assert.deepEqual([pulled.event, pulled.imported, pulled.alreadyHere], ['Cottage Weekend', 3, 0]);
  assert.equal(pulled.unused, undefined);
  let snapshot = await browser(p + '/snapshot');
  const memory = snapshot.events.find(item => item.title === 'Cottage Weekend');
  assert.equal(memory.sourceIds.length, 3);
  assert.equal(snapshot.session.eventId, memory.id);
  assert.equal(snapshot.session.view, 'explore');
  assert.ok(snapshot.media.filter(item => memory.sourceIds.includes(item.id)).every(item => !item.pending && item.mime === 'image/jpeg'));

  const again = await voice('pull_event_photos', { event: 'Cottage Weekend' });
  assert.deepEqual([again.imported, again.alreadyHere], [0, 3]);
  snapshot = await browser(p + '/snapshot');
  assert.equal(snapshot.events.filter(item => item.title === 'Cottage Weekend').length, 1);
  assert.equal(snapshot.media.length, 3);

  const opened = await voice('open_immersive_album');
  assert.deepEqual([opened.event, opened.photos], ['Cottage Weekend', 3]);
  snapshot = await browser(p + '/snapshot');
  assert.ok(snapshot.session.albumRequest.id);
  assert.ok(Date.now() - Date.parse(snapshot.session.albumRequest.at) < 5000);

  const lake = await browser(p + '/photo-library/pull', { event: 'Lake Trip' });
  assert.deepEqual([lake.event, lake.imported], ['Lake Trip', 2]);
  assert.equal((await browser(p + '/snapshot')).events.length, 2);
});

test('event names are matched from speech, and a machine with no library says so', async () => {
  const events = [{ name: 'Cottage Weekend' }, { name: 'Lake Trip' }, { name: 'Lake House' }, { name: 'Lake' }];
  assert.equal(findEvent(events, 'cottage').name, 'Cottage Weekend');
  assert.equal(findEvent(events, 'Lake').name, 'Lake');
  assert.equal(findEvent(events, 'my lake trip').name, 'Lake Trip');
  assert.equal(findEvent(events.slice(0, 3), 'lake'), null);
  assert.equal(findEvent(events, '!!!'), null);
  const none = createPhotoLibrary({ folder: '', platform: 'linux' });
  await assert.rejects(none.events(), { code: 'PHOTO_LIBRARY_UNAVAILABLE' });
  const denied = createPhotoLibrary({ folder: '', platform: 'darwin', execute: async () => { throw Object.assign(new Error('fail'), { stderr: 'execution error: Not authorized to send Apple events to Photos. (-1743)' }); } });
  await assert.rejects(denied.events(), { code: 'PHOTO_LIBRARY_DENIED', status: 403 });
  const mac = createPhotoLibrary({ folder: '', platform: 'darwin', execute: async () => ({ stdout: JSON.stringify([{ id: 'a1', name: 'Paris', count: 4 }, { id: 'a2', name: 'Empty', count: 0 }]) }) });
  assert.deepEqual(await mac.events(), [{ id: 'a1', name: 'Paris', count: 4 }]);
});
