import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { storeTour } from '../packages/media/tour.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'everwhere-tour-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'assets');
}

async function image(width = 128, height = 64, format = 'jpeg', orientation) {
  let pipeline = sharp({ create: { width, height, channels: 3, background: '#b8c8d8' } });
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  return 'data:image/' + format + ';base64,' + (await pipeline[format]().toBuffer()).toString('base64');
}

const picture = await image();
const node = (id, links = []) => ({ id, title: 'View ' + id, description: 'A public reference viewpoint.\nNot measured geometry.', image: picture, projection: 'perspective', links });
const fixture = () => ({ version: 'everwhere-tour-1', title: 'Tremblant reference walkthrough', startNodeId: 'street', nodes: [
  { ...node('street', [{ to: 'door', label: 'Walk toward the door', yaw: 25, pitch: -12, kind: 'walk' }]), sourceIds: ['photo-1'],
    facts: [{ text: 'A cited place description.', url: 'https://www.tremblant.ca/things-to-do' }],
    streetViewUrl: 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=46.2,-74.5' },
  node('door', [{ to: 'street', label: 'Step outside', kind: 'door' }])
] });
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

const liveTour = () => ({ version: 'everwhere-tour-1', title: 'Reviewed village route', startNodeId: 'village', nodes: [
  { id: 'village', title: 'Village', projection: 'streetview', streetView: { lat: 46.21, lng: -74.58, heading: 270, pitch: -5, panoId: 'public-pano-hint' }, links: [] }
] });

test('live Street View locators preserve authored inputs and earn capability only when every node is live', async t => {
  const dir = await setup(t);
  const tour = liveTour();
  const result = await storeTour(bytes(tour), 'village.tour.json', dir);
  assert.equal(result.tour.liveStreetView, true);
  assert.deepEqual(JSON.parse(await readFile(result.storage, 'utf8')), tour);
  assert.doesNotMatch(JSON.stringify(result.tour), /panoId|public-pano-hint|streetView/);
  tour.nodes.push({ ...node('photo'), links: [{ to: 'village', label: 'Return' }] });
  tour.nodes[0].links.push({ to: 'photo', label: 'Photo' });
  assert.equal((await storeTour(bytes(tour), 'mixed.tour.json', dir)).tour.liveStreetView, undefined);
  const legacy = liveTour(); delete legacy.nodes[0].streetView;
  legacy.nodes[0].streetViewEmbedUrl = 'https://www.google.com/maps/embed?pb=public';
  assert.equal((await storeTour(bytes(legacy), 'legacy.tour.json', dir)).tour.liveStreetView, undefined);
});

test('live locators reject missing, out-of-range, unknown, ambiguous or executable inputs before writing', async t => {
  const dir = await setup(t);
  for (const locator of [null, [], {}, { lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: '0', lng: 0 },
    { lat: null, lng: 0 }, { lat: 0, lng: 0, heading: -1 }, { lat: 0, lng: 0, heading: 361 },
    { lat: 0, lng: 0, pitch: 91 }, { lat: 0, lng: 0, panoId: '' }, { lat: 0, lng: 0, panoId: 'x'.repeat(257) },
    { lat: 0, lng: 0, panoId: 'a\nb' }, { lat: 0, lng: 0, url: 'https://other.example/script.js' }]) {
    const tour = liveTour(); tour.nodes[0].streetView = locator;
    await rejected(dir, tour);
  }
  const both = liveTour(); both.nodes[0].streetViewEmbedUrl = 'https://www.google.com/maps/embed?pb=public';
  await rejected(dir, both, 'INVALID_TOUR_PROJECTION');
  const copied = liveTour(); copied.nodes[0].image = picture;
  await rejected(dir, copied, 'INVALID_TOUR_IMAGE');
  const wrong = fixture(); wrong.nodes[0].streetView = { lat: 0, lng: 0 };
  await rejected(dir, wrong, 'INVALID_TOUR_PROJECTION');
  const bounds = liveTour(); bounds.nodes[0].streetView = { lat: -90, lng: 180, heading: 360, pitch: -90 };
  assert.equal((await storeTour(bytes(bounds), 'bounds.tour.json', dir)).tour.liveStreetView, true);
});

async function rejected(dir, value, code, filename = 'bad.tour.json') {
  const before = await readdir(dir).catch(() => []);
  await assert.rejects(storeTour(Buffer.isBuffer(value) ? value : bytes(value), filename, dir), error => {
    assert.ok([400, 413].includes(error.status), 'Validation must produce a user-readable client error');
    if (code) assert.equal(error.code, code);
    return true;
  });
  assert.deepEqual(await readdir(dir).catch(() => []), before, 'Rejected tours must not leave asset files');
}

test('a linked photo tour preserves original bytes and returns only compact source-linked node metadata', async t => {
  const dir = await setup(t);
  const input = bytes(fixture());
  const result = await storeTour(input, 'Tremblant.tour.json', dir);
  assert.equal(result.format, 'tour');
  assert.equal(result.points, 2);
  assert.equal(result.title, 'Tremblant reference walkthrough');
  assert.equal(result.contentHash, createHash('sha256').update(input).digest('hex'));
  assert.deepEqual(await readFile(result.storage), input);
  assert.deepEqual(result.tour, { startNodeId: 'street', nodes: [
    { id: 'street', title: 'View street', sourceIds: ['photo-1'] }, { id: 'door', title: 'View door' }
  ] });
  assert.doesNotMatch(JSON.stringify(result), /data:image|base64|facts|streetViewUrl/);
  const second = await storeTour(input, 'different-name.tour.json', dir);
  assert.equal(second.contentHash, result.contentHash);
  assert.notEqual(second.id, result.id);
});

test('valid single-view panoramas and fully reachable eight-view tours are accepted', async t => {
  const dir = await setup(t);
  const panorama = { version: 'everwhere-tour-1', title: 'Panorama', startNodeId: 'pano', nodes: [
    { ...node('pano'), projection: 'equirectangular', image: await image(256, 128, 'png') }
  ] };
  assert.equal((await storeTour(bytes(panorama), 'pano.tour.json', dir)).points, 1);
  const chain = { version: 'everwhere-tour-1', title: 'Eight views', startNodeId: 'n0', nodes: Array.from({ length: 8 }, (_, index) =>
    node('n' + index, [{ to: 'n' + ((index + 1) % 8), label: 'Next view' }])) };
  assert.equal((await storeTour(bytes(chain), 'eight.tour.json', dir)).points, 8);
});

test('missing destinations, duplicate IDs, missing starts and unreachable views are rejected before storage', async t => {
  const dir = await setup(t);
  for (const change of [
    value => { value.startNodeId = 'absent'; },
    value => { value.nodes[1].id = 'street'; },
    value => { value.nodes[0].links[0].to = 'missing'; },
    value => { value.nodes[0].links = []; },
    value => { value.nodes.push(node('disconnected', [{ to: 'street', label: 'One-way inward link' }])); }
  ]) {
    const value = fixture(); change(value);
    await rejected(dir, value, 'INVALID_TOUR_GRAPH');
  }
});

test('tour size, node count, field shapes, IDs and navigation angles are bounded', async t => {
  const dir = await setup(t);
  await rejected(dir, Buffer.alloc(48 * 1024 ** 2 + 1), 'TOUR_LIMIT');
  await rejected(dir, fixture(), 'TOUR_REQUIRED', 'wrong.json');
  await rejected(dir, Buffer.from('(() => alert(1))()'), 'INVALID_TOUR');
  for (const change of [
    value => { value.nodes = []; }, value => { value.nodes = Array.from({ length: 9 }, (_, index) => node('n' + index)); }
  ]) { const value = fixture(); change(value); await rejected(dir, value, 'TOUR_LIMIT'); }
  for (const change of [
    value => { value.version = 'other'; }, value => { value.title = ' '; },
    value => { value.nodes[0].id = '../../path'; }, value => { value.nodes[0].id = '__proto__\n'; },
    value => { value.nodes[0].description = 'x'.repeat(2049); },
    value => { value.nodes[0].links[0].label = ''; }, value => { value.nodes[0].links[0].yaw = 181; },
    value => { value.nodes[0].links[0].pitch = -91; }, value => { value.nodes[0].links[0].yaw = '0'; },
    value => { value.nodes[0].links[0].kind = 'script'; }, value => { value.nodes[0].sourceIds = ['duplicate', 'duplicate']; },
    value => { value.nodes[0].sourceIds = [123]; }, value => { value.nodes[0].onClick = 'alert(1)'; },
    value => { value.nodes[0].facts[0].script = 'alert(1)'; }, value => { value.remoteData = 'https://example.com/script.js'; }
  ]) { const value = fixture(); change(value); await rejected(dir, value); }
});

test('remote image links, SVG/HTML payloads, mismatched MIME and broken base64 or image data are rejected', async t => {
  const dir = await setup(t);
  const png = await image(128, 64, 'png');
  const corruptJpeg = Buffer.from(picture.split(',')[1], 'base64').subarray(0, 100).toString('base64');
  for (const invalid of [
    'https://example.com/photo.jpg', 'file:///tmp/photo.jpg', 'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,aGVsbG8=',
    png.replace('image/png', 'image/jpeg'), 'data:image/jpeg;base64,%%%%',
    'data:image/jpeg;base64,aGVsbG8=', 'data:image/jpeg;base64,' + corruptJpeg
  ]) {
    const value = fixture(); value.nodes[0].image = invalid;
    await rejected(dir, value);
  }
});

test('oversized dimensions and decompression-sized pixel counts are rejected before image storage', async t => {
  const dir = await setup(t);
  for (const oversized of [await image(8193, 1, 'png'), await image(8000, 4001, 'png')]) {
    const value = fixture(); value.nodes[0].image = oversized;
    await rejected(dir, value, 'INVALID_TOUR_IMAGE');
  }
});

test('equirectangular views require displayed 2:1 proportions including EXIF rotation', async t => {
  const dir = await setup(t);
  for (const nonPanorama of [await image(128, 63), await image(128, 64, 'jpeg', 6)]) {
    const value = fixture(); Object.assign(value.nodes[0], { image: nonPanorama, projection: 'equirectangular' });
    await rejected(dir, value, 'INVALID_TOUR_PROJECTION');
  }
});

test('facts reject local, credential-bearing and executable URLs; Street View stays on Google Maps', async t => {
  const dir = await setup(t);
  for (const invalid of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd',
    'https://user:password@example.com/fact', 'http://localhost/fact', 'http://localhost./fact',
    'http://127.0.0.1/fact', 'http://2130706433/fact', 'http://10.0.0.1/fact', 'http://[::1]/fact', 'http://service.internal/fact']) {
    const value = fixture(); value.nodes[0].facts[0].url = invalid;
    await rejected(dir, value, 'INVALID_TOUR_URL');
  }
  for (const invalid of ['http://www.google.com/maps/', 'https://www.google.com/maps-evil/',
    'https://www.google.com.evil.example/maps/', 'https://evil.example/maps/', 'https://www.google.com/search?q=maps']) {
    const value = fixture(); value.nodes[0].streetViewUrl = invalid;
    await rejected(dir, value, 'INVALID_TOUR_URL');
  }
});

test('Street View nodes retain official public embeds without image copies, including generic occasions', async t => {
  const dir = await setup(t);
  const tour = { version: 'everwhere-tour-1', title: 'Birthday dinner venue', startNodeId: 'venue', nodes: [{
    id: 'venue', title: 'Inside the venue', description: 'Official interactive venue tour, not the birthday itself.',
    projection: 'streetview', streetViewEmbedUrl: 'https://www.google.com/maps/embed?pb=!4v12345!6m8!1m7', links: [], sourceIds: ['venue-reference']
  }] };
  const original = bytes(tour);
  const result = await storeTour(original, 'Birthday.tour.json', dir);
  assert.equal(result.points, 1);
  assert.deepEqual(await readFile(result.storage), original);
  assert.deepEqual(result.tour.nodes, [{ id: 'venue', title: 'Inside the venue', sourceIds: ['venue-reference'] }]);
  assert.equal(JSON.parse((await readFile(result.storage)).toString()).nodes[0].image, undefined);
});

test('Street View embeds reject keyed routes, extra parameters, fragments, credentials and disguised domains', async t => {
  const dir = await setup(t);
  const validUrl = 'https://www.google.com/maps/embed?pb=!4v12345';
  const tour = () => ({ version: 'everwhere-tour-1', title: 'Networking venue', startNodeId: 'venue', nodes: [{
    id: 'venue', title: 'Venue', projection: 'streetview', streetViewEmbedUrl: validUrl, links: []
  }] });
  for (const invalid of [
    undefined, '', 'https://www.google.com/maps/embed/v1/streetview?key=not-a-key&location=1,2',
    'https://www.google.com/maps/embed?pb=one&key=not-a-key', 'https://www.google.com/maps/embed?pb=one&pb=two',
    'https://www.google.com/maps/embed?pb=', 'https://www.google.com/maps/embed?pb=%20',
    validUrl + '#section', validUrl + '#', 'http://www.google.com/maps/embed?pb=one',
    'https://user:pass@www.google.com/maps/embed?pb=one', 'https://www.google.com:444/maps/embed?pb=one',
    'https://www.google.com.evil.example/maps/embed?pb=one', 'https://evil.example/maps/embed?pb=one',
    'https://www.google.com/maps/embed/?pb=one', 'https://maps.google.com/maps/embed?pb=one'
  ]) {
    const value = tour(); value.nodes[0].streetViewEmbedUrl = invalid;
    await rejected(dir, value);
  }
  const copiedPixels = tour(); copiedPixels.nodes[0].image = picture;
  await rejected(dir, copiedPixels, 'INVALID_TOUR_IMAGE');
  const wrongProjection = fixture(); wrongProjection.nodes[0].streetViewEmbedUrl = validUrl;
  await rejected(dir, wrongProjection, 'INVALID_TOUR_PROJECTION');
  const missingImage = fixture(); delete missingImage.nodes[0].image;
  await rejected(dir, missingImage, 'TOUR_IMAGE_REQUIRED');
});
