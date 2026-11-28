import assert from 'node:assert/strict';
import test from 'node:test';
import { albumEnd, moveInAlbum, nearbyPhoto, orderedPhotos, photoStops } from '../apps/web/src/album-layout.ts';
import { sourcesFor } from '../apps/web/src/model.ts';

const photo = (id, capturedAt = null, provenance = 'original') => ({ id, mime: 'image/jpeg', caption: id, capturedAt, provenance });

test('album selection uses linked, available photos allowed by the current lens and orders capture dates', () => {
  const media = [photo('late', '2024-10-14'), photo('unknown'), photo('early', '2024-10-12'),
    photo('imagined', '2024-10-11', 'imagined'), { ...photo('clip'), mime: 'video/mp4' }, photo('unlinked')];
  const ids = ['late', 'unknown', 'early', 'imagined', 'clip', 'revoked'];
  const state = { media, session: { lens: 'originals' } };
  assert.deepEqual(orderedPhotos(sourcesFor(state, ids)).map(item => item.id), ['early', 'late', 'unknown']);
  assert.deepEqual(media.map(item => item.id), ['late', 'unknown', 'early', 'imagined', 'clip', 'unlinked']);
  state.session.lens = 'all';
  assert.deepEqual(orderedPhotos(sourcesFor(state, ids)).map(item => item.id), ['imagined', 'early', 'late', 'unknown']);
  assert.deepEqual(orderedPhotos([]), []);
});

test('walking translates the camera, follows its direction and stays within the promenade', () => {
  const end = albumEnd(8);
  assert.deepEqual(moveInAlbum({ x: 0, z: 6 }, 0, 1, 0, 3, end), { x: 0, z: 3 });
  const turned = moveInAlbum({ x: 0, z: 0 }, Math.PI / 2, 1, 0, 2, end);
  assert.equal(turned.x, -2);
  assert.ok(Math.abs(turned.z) < 0.000001);
  const diagonal = moveInAlbum({ x: 0, z: 0 }, 0, 1, 1, 2, end);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 2) < 0.000001);
  assert.deepEqual(moveInAlbum({ x: 3.4, z: 7 }, 0, -1, 1, 50, end), { x: 3.4, z: 7 });
  assert.equal(moveInAlbum({ x: 0, z: 0 }, 0, 1, 0, 1000, end).z, end + 2);
});

test('every photo receives a reachable stop and interaction requires proximity', () => {
  const stops = photoStops(Array.from({ length: 25 }, (_, index) => photo(String(index))));
  assert.equal(stops.length, 25);
  assert.equal(new Set(stops.map(stop => stop.x + ',' + stop.z)).size, 25);
  assert.equal(nearbyPhoto({ x: 0, z: 6 }, stops), undefined);
  for (const stop of stops) {
    const approach = { x: stop.x < 0 ? -1.8 : 1.8, z: stop.z };
    assert.equal(nearbyPhoto(approach, stops)?.sourceId, stop.sourceId);
    assert.ok(stop.z >= albumEnd(stops.length) + 2);
  }
});
