import test from 'node:test';
import assert from 'node:assert/strict';
import { readTour, directionLink, safeReferenceURL, safeStreetViewEmbed, normalizedYaw } from '../apps/web/src/panorama-navigation.ts';
const image = 'data:image/jpeg;base64,AAAA';
const fixture = () => ({ version: 'everwhere-tour-1', title: 'A winter village', startNodeId: 'street', nodes: [
  { id: 'street', title: 'Village street', description: 'A generated winter interpretation.', image, projection: 'perspective', links: [
    { to: 'square', label: 'Continue to the square', yaw: 0 }, { to: 'cafe', label: 'Enter the café', yaw: 50, kind: 'door' }] },
  { id: 'square', title: 'Square', description: '', image, projection: 'equirectangular', links: [{ to: 'street', label: 'Return to the street', yaw: 180 }] },
  { id: 'cafe', title: 'Café', description: '', image, projection: 'perspective', links: [{ to: 'street', label: 'Go outside', yaw: 180, kind: 'door' }] }
] });
test('linked tour navigation distinguishes forward, side doors and the return route', () => {
  const tour = readTour(fixture());
  assert.equal(directionLink(tour.nodes[0], 'forward').to, 'square');
  assert.equal(directionLink(tour.nodes[0], 'right').to, 'cafe');
  assert.equal(directionLink(tour.nodes[0], 'forward', 50).to, 'cafe');
  assert.equal(directionLink(tour.nodes[0], 'left'), undefined);
  assert.equal(directionLink(tour.nodes[2], 'back').to, 'street');
  assert.equal(directionLink(tour.nodes[2], 'forward'), undefined);
  assert.equal(normalizedYaw(350), -10);
});
test('scene validation rejects dangling routes, duplicate viewpoints and external or executable image sources', () => {
  for (const change of [tour => { tour.nodes[0].links[0].to = 'absent'; }, tour => { tour.nodes[1].id = 'street'; },
    tour => { tour.startNodeId = 'absent'; }, tour => { tour.nodes[0].image = 'https://example.com/private.jpg'; },
    tour => { tour.nodes[0].image = 'data:image/svg+xml,<svg></svg>'; },
    tour => { tour.nodes[0].image = 'data:image/webp;base64,AAAA'; },
    tour => { tour.nodes.push(...Array.from({length:6},(_,i)=>({...tour.nodes[0],id:'extra-'+i}))); }, tour => { tour.nodes[0].links[0].yaw = Infinity; }]) {
    const tour = fixture(); change(tour); assert.throws(() => readTour(tour));
  }
});
test('source context retains safe cited facts while discarding executable or credential-bearing links', () => {
  const tour = fixture();
  tour.nodes[0].facts = [{ text: 'Public place context.', url: 'https://en.wikipedia.org/wiki/Mont-Tremblant' }, { text: 'Unsafe.', url: 'javascript:alert(1)' }];
  tour.nodes[0].streetViewUrl = 'https://www.google.com/maps?layer=c';
  const result = readTour(tour);
  assert.equal(result.nodes[0].facts.length, 1);
  assert.equal(result.nodes[0].streetViewUrl, tour.nodes[0].streetViewUrl);
  assert.equal(safeReferenceURL('https://name:password@example.com'), undefined);
});
test('Street View nodes use an official Google embed without requiring or copying an image', () => {
  const tour = fixture();
  tour.nodes[2].projection = 'streetview';
  delete tour.nodes[2].image;
  delete tour.nodes[2].description;
  tour.nodes[2].streetViewEmbedUrl = 'https://www.google.com/maps/embed?pb=official-panorama';
  assert.equal(readTour(tour).nodes[2].projection, 'streetview');
  for (const url of ['https://google.com.evil.example/maps/embed?pb=x', 'http://www.google.com/maps/embed?pb=x',
    'https://www.google.com/maps/embed', 'https://www.google.com/maps/other?pb=x', 'https://www.google.com/maps/embed?pb=x&key=secret',
    'https://www.google.com/maps/embed?pb=x#fragment', 'javascript:alert(1)']) {
    assert.equal(safeStreetViewEmbed(url), undefined);
    tour.nodes[2].streetViewEmbedUrl = url;
    assert.throws(() => readTour(tour));
  }
});

test('live Street View locators are validated and mark only all-live tours', async () => {
  const { safeStreetViewLocator } = await import('../apps/web/src/panorama-navigation.ts');
  const live = (streetView, extra = {}) => ({ version: 'everwhere-tour-1', title: 'Village', startNodeId: 'a', nodes: [
    { id: 'a', title: 'Square', projection: 'streetview', links: [], streetView, ...extra }] });
  const tour = readTour(live({ lat: 46.21, lng: -74.58, heading: 90, panoId: 'hint' }));
  assert.equal(tour.liveStreetView, true);
  assert.deepEqual(tour.nodes[0].streetView, { lat: 46.21, lng: -74.58, heading: 90, panoId: 'hint' });
  for (const bad of [{ lat: 91, lng: 0 }, { lat: 0 }, { lat: 0, lng: 0, heading: 361 }, { lat: 0, lng: 0, pitch: -91 }, { lat: 0, lng: 0, panoId: '' },
    { lat: 0, lng: 0, url: 'https://example.com/tiles' }, { lat: '46', lng: 0 }, null]) assert.throws(() => readTour(live(bad)));
  assert.equal(safeStreetViewLocator({ lat: 0, lng: 0, panoId: 'a\nb' }), undefined);
  assert.throws(() => readTour(live({ lat: 0, lng: 0 }, { streetViewEmbedUrl: 'https://www.google.com/maps/embed?pb=x' })));
  const mixed = fixture();
  mixed.nodes[0] = { ...mixed.nodes[0], streetView: { lat: 0, lng: 0 } };
  assert.throws(() => readTour(mixed));
  assert.equal(readTour(fixture()).liveStreetView, undefined);
});

test('provider links are chosen relative to the current heading and missing paths block', async () => {
  const { panoramaLink } = await import('../apps/web/src/panorama-navigation.ts');
  const links = [{ heading: 10, pano: 'north' }, { heading: 185, pano: 'south' }, { heading: 100, pano: 'east' }, null, { heading: 50 }];
  assert.equal(panoramaLink(links, 0, 'forward').pano, 'north');
  assert.equal(panoramaLink(links, 0, 'backward').pano, 'south');
  assert.equal(panoramaLink(links, 0, 'right').pano, 'east');
  assert.equal(panoramaLink(links, 0, 'left'), undefined);
  assert.equal(panoramaLink(links, 350, 'forward').pano, 'north');
  assert.equal(panoramaLink(links, 180, 'forward').pano, 'south');
  assert.equal(panoramaLink([], 0, 'forward'), undefined);
});
