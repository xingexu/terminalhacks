import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createMemory, digest, eventDependencies, generationDependencies } from '../packages/runtime/memory.mjs';
import { renderFilm } from '../packages/media/local.mjs';
import { createStore } from '../apps/api/store.mjs';
import {
  capturePreview, commitCommand, createFilmWorker, getSnapshot, observe, previewCommand, previewFilm,
  queueFilm, revokeCapture, startCapture
} from '../apps/api/service.mjs';

const actor = 'storyboard-reviewer';
const eventId = 'e-lake';

function fixture() {
  const state = createMemory('Storyboard test', true);
  const photos = Array.from('abcdefghij', (id, index) => ({
    id, caption: 'Source ' + id.toUpperCase(), mime: 'image/jpeg', provenance: 'original',
    capturedAt: index < 8 ? `2024-01-01T00:0${index}:00Z` : index === 8 ? null : 'unknown',
    hash: digest(id), storage: '/private/' + id + '.jpg', thumb: '/private/' + id + '-thumb.jpg'
  }));
  state.media = [...state.media.filter(item => !['m-lake', 'm-boats'].includes(item.id)), ...photos];
  state.events[0].sourceIds = photos.map(item => item.id).reverse();
  state.anchors = state.anchors.filter(item => item.eventId !== eventId);
  return state;
}

function commit(state, type, payload, targetId = eventId) {
  const command = { type, payload, targetId, expectedRevision: state.revision };
  const preview = previewCommand(state, command, actor);
  const input = { ...command, previewToken: preview.previewToken, requestId: randomUUID() };
  return { input, result: commitCommand(state, input, actor) };
}

function queue(state) {
  const preview = previewFilm(state, { eventId, expectedRevision: state.revision }, actor);
  const input = { previewToken: preview.previewToken, requestId: randomUUID() };
  const result = queueFilm(state, input, actor);
  return { preview, input, result, job: state.jobs.find(item => item.id === result.id) };
}

function world(state, sourceIds, generated = false) {
  const id = randomUUID();
  const evidenceRefs = { mediaIds: sourceIds, recollectionIds: [] };
  const item = {
    id, eventId, format: 'glb', status: 'ready', approved: true, provenance: 'imagined', sourceIds,
    inputHash: digest([id, sourceIds]), contentHash: digest('mesh'), storage: '/private/world.glb',
    ...(generated && {
      planId: 'plan-' + id, plan: { id: 'plan-' + id, sourceIds }, evidenceRefs,
      evidenceHash: digest(generationDependencies(state, eventId, evidenceRefs))
    })
  };
  state.worlds.push(item);
  return item;
}

test('one bounded storyboard exposes the exact ordered cut, omitted evidence and attributed excerpts', () => {
  const state = fixture();
  state.media.push({ id: 'pending', mime: 'image/jpeg', provenance: 'original', pending: true, caption: 'Not reviewed' });
  state.events[0].sourceIds.push('pending');
  state.recollections = Array.from({ length: 10 }, (_, index) => ({
    id: 'r-' + index, eventId, at: `2024-01-01T01:0${index}:00Z`, actor,
    text: index ? 'Recollection ' + index : 'x'.repeat(179) + '🙂' + ' continued'
  })).reverse();
  const storyboard = eventDependencies(state, eventId, 'all').storyboard;
  assert.equal(storyboard.kind, 'source_montage');
  assert.equal(storyboard.basis, 'memory_sources');
  assert.equal(storyboard.worldId, null);
  assert.equal(storyboard.planId, null);
  assert.deepEqual(storyboard.frames.map(item => item.sourceId), Array.from('abcdefgh'));
  assert.deepEqual(storyboard.excludedSourceIds, ['i', 'j']);
  assert.deepEqual(storyboard.sourceIds, Array.from('abcdefghij'));
  assert.equal(storyboard.durationSeconds, storyboard.frames.reduce((sum, item) => sum + item.seconds, 0));
  assert.equal(storyboard.frames[0].recollection.id, 'r-0');
  assert.equal(storyboard.frames[0].recollection.contributor, 'You');
  assert.equal(storyboard.frames[0].recollection.excerpt, true);
  assert.equal(storyboard.frames[0].recollection.text, 'x'.repeat(179) + '🙂…');
  assert.equal(storyboard.omittedRecollections, 2);
  assert.equal(JSON.stringify(storyboard).includes('/private/'), false);
  assert.deepEqual(getSnapshot('project', state).storyboards[eventId], storyboard);
  const film = queue(state);
  assert.equal(film.preview.diff.sources, 8);
  assert.deepEqual(film.preview.diff.storyboard, storyboard);
  assert.deepEqual(film.result.storyboard, storyboard);
  assert.deepEqual(getSnapshot('project', state).jobs[0].storyboard, storyboard);
});

test('approved generated order is reused, while unapproved or invalid worlds cannot drive the cut', () => {
  const state = fixture();
  const generated = world(state, ['c', 'a'], true);
  const storyboard = eventDependencies(state, eventId, 'all').storyboard;
  assert.equal(storyboard.basis, 'world_plan');
  assert.equal(storyboard.planId, generated.planId);
  assert.deepEqual(storyboard.frames.map(item => item.sourceId), ['c', 'a']);
  assert.deepEqual(storyboard.sourceIds, Array.from('cabdefghij'));
  for (const invalidate of [
    item => { item.approved = false; },
    item => { item.status = 'stale'; },
    item => { item.revoked = true; },
    item => { item.sourceIds.push('missing'); },
    item => { item.evidenceHash = 'outdated evidence'; }
  ]) {
    const copy = structuredClone(state);
    invalidate(copy.worlds[0]);
    assert.equal(eventDependencies(copy, eventId, 'all').storyboard.basis, 'memory_sources');
  }
});

test('an imported world uses dated evidence rather than canonical ID order, and originals-only hides worlds', () => {
  const state = fixture();
  const imported = world(state, ['j', 'g', 'b']);
  const laterSplat = world(state, ['a']);
  laterSplat.format = 'spz';
  state.anchors.push({ id: 'included', eventId, sourceIds: ['g'] }, { id: 'outside-cut', eventId, sourceIds: ['e'] });
  state.recollections.push(
    { id: 'outside-account', eventId, anchorId: 'outside-cut', text: 'An account from another stop.' },
    { id: 'included-account', eventId, anchorId: 'included', text: 'An account tied to source G.' }
  );
  const storyboard = eventDependencies(state, eventId, 'all').storyboard;
  assert.equal(storyboard.worldId, imported.id, 'The primary walkable world takes precedence over a splat');
  assert.equal(storyboard.basis, 'world_sources');
  assert.equal(storyboard.planId, null);
  assert.deepEqual(storyboard.frames.map(item => item.sourceId), ['b', 'g', 'j']);
  assert.equal(storyboard.frames[0].recollection, undefined);
  assert.equal(storyboard.frames[1].recollection.id, 'included-account');
  assert.equal(storyboard.omittedRecollections, 1);
  state.media.find(item => item.id === 'a').provenance = 'imagined';
  const originals = eventDependencies(state, eventId, 'originals').storyboard;
  assert.equal(originals.worldId, null);
  assert.equal(originals.basis, 'memory_sources');
  assert.equal(originals.sourceIds.includes('a'), false);
});

test('film approval and unrelated edits preserve the cut, but correcting its world evidence retires both', () => {
  let state = fixture();
  world(state, ['c', 'a'], true);
  const film = queue(state);
  Object.assign(film.job, { status: 'ready', contentHash: digest('film bytes') });
  state = structuredClone(state);
  const before = digest(eventDependencies(state, eventId, 'all'));
  commit(state, 'artifact.approve', { artifactId: film.job.id, dependencyHash: film.job.inputHash });
  assert.equal(state.jobs[0].status, 'ready');
  assert.equal(state.jobs[0].approved, true);
  commit(state, 'event.correct', { patch: { title: 'An unrelated correction' } }, 'e-cabin');
  assert.equal(digest(eventDependencies(state, eventId, 'all')), before);
  const pending = previewFilm(state, { eventId, expectedRevision: state.revision }, actor);
  commit(state, 'event.correct', { patch: { story: 'The date and landscape needed correcting.' } });
  assert.equal(state.worlds[0].status, 'stale');
  assert.equal(state.jobs[0].status, 'stale');
  assert.equal(state.jobs[0].approved, false);
  assert.equal(eventDependencies(state, eventId, 'all').storyboard.worldId, null);
  assert.throws(() => queueFilm(state, { previewToken: pending.previewToken, requestId: randomUUID() }, actor),
    error => error.status === 409);
});

test('narration belongs to a displayed account and is bounded to its own shot', () => {
  const state = fixture();
  world(state, ['a', 'b']);
  state.anchors.push({ id: 'outside', eventId, sourceIds: ['c'] }, { id: 'inside', eventId, sourceIds: ['b'] });
  const outside = { id: 'outside-audio', mime: 'audio/webm', provenance: 'original', duration: 8, storage: '/private/outside.webm' };
  const inside = { id: 'inside-audio', mime: 'audio/webm', provenance: 'original', duration: 2, storage: '/private/inside.webm' };
  state.media.push(outside, inside);
  state.recollections.push({ id: 'outside-account', eventId, anchorId: 'outside', audioMediaId: outside.id,
    text: 'This voice note belongs to another source.', at: '2024-01-01T00:00:00Z' });
  let manifest = eventDependencies(state, eventId, 'all');
  assert.equal(manifest.storyboard.narration, null);
  assert.equal(manifest.narration, null);
  state.recollections.push({ id: 'inside-account', eventId, anchorId: 'inside', audioMediaId: inside.id,
    text: 'This note describes source B.', at: '2024-01-01T01:00:00Z' });
  manifest = eventDependencies(state, eventId, 'all');
  assert.equal(manifest.narration.id, inside.id);
  assert.deepEqual(manifest.storyboard.narration, {
    sourceId: inside.id, recollectionId: 'inside-account', startSeconds: manifest.storyboard.frames[0].seconds, seconds: 2
  });
  assert.equal(JSON.stringify(manifest.storyboard).includes('/private/'), false);
  inside.duration = 100;
  assert.equal(eventDependencies(state, eventId, 'all').storyboard.narration.seconds, manifest.storyboard.frames[1].seconds);
  delete inside.duration;
  assert.equal(eventDependencies(state, eventId, 'all').storyboard.narration.seconds, manifest.storyboard.frames[1].seconds);
});

test('undo hides stale storyboard excerpts from snapshots and queue replays without caching a second copy', () => {
  let state = fixture();
  const secret = 'An account removed from the current memory by undo.';
  commit(state, 'recollection.add', { text: secret });
  const film = queue(state);
  assert.equal(film.result.storyboard.frames[0].recollection.text, secret);
  assert.deepEqual(state.requests['film:' + film.input.requestId].result, { id: film.job.id });
  state = structuredClone(state);
  commit(state, 'undo', { revisionToUndo: state.changes[0].revision });
  const snapshot = getSnapshot('project', state);
  assert.equal(snapshot.jobs[0].status, 'stale');
  assert.equal(snapshot.jobs[0].storyboard, undefined);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  const replay = queueFilm(state, film.input, actor);
  assert.equal(replay.id, film.job.id);
  assert.equal(replay.status, 'stale');
  assert.equal(replay.storyboard, undefined);
  assert.equal(JSON.stringify(replay).includes(secret), false);
  assert.equal(JSON.stringify(state.requests['film:' + film.input.requestId]).includes(secret), false);
});

test('withdrawing VoiceOS text scrubs the storyboard from previews, jobs and cached queue responses', () => {
  let state = fixture();
  const secret = 'Withdraw this private account from the storyboard everywhere.';
  const session = startCapture(state, { source: 'voiceos_text', consent: true });
  const { observationId } = observe(state, { sessionId: session.id, externalId: randomUUID(), source: 'voiceos_text',
    kind: 'recollection', capturedAt: null, location: null, text: secret });
  const preview = capturePreview(state, observationId, { eventId, expectedRevision: state.revision }, actor);
  commitCommand(state, { ...preview.command, previewToken: preview.previewToken, requestId: randomUUID() }, actor);
  const film = queue(state);
  const pending = previewFilm(state, { eventId, expectedRevision: state.revision }, actor);
  assert.ok(JSON.stringify(state.previews[pending.previewToken]).includes(secret));
  state = structuredClone(state);
  revokeCapture(state, session.grantId);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(state.previews[pending.previewToken], undefined);
  assert.equal(getSnapshot('project', state).jobs[0].storyboard, undefined);
  assert.throws(() => queueFilm(state, film.input, actor), error => error.code === 'EVIDENCE_REVOKED');
});

test('withdrawing a source removes its reviewed caption from pending and retained storyboards', () => {
  let state = fixture();
  const session = startCapture(state, { source: 'selected_file', consent: true });
  const secret = 'Private source caption to withdraw';
  Object.assign(state.media.find(item => item.id === 'a'), { captureGrant: session.grantId, caption: secret });
  world(state, ['a', 'b']);
  const film = queue(state);
  const pending = previewFilm(state, { eventId, expectedRevision: state.revision }, actor);
  state = structuredClone(state);
  revokeCapture(state, session.grantId);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(state.previews[pending.previewToken], undefined);
  assert.equal(getSnapshot('project', state).storyboards[eventId].sourceIds.includes('a'), false);
  assert.equal(state.worlds[0].revoked, true);
  assert.throws(() => queueFilm(state, film.input, actor), error => error.code === 'EVIDENCE_REVOKED');
});

test('the actual film captions and duration follow the reviewed eight-frame cut', async t => {
  const state = fixture();
  for (const source of state.media) source.demoFile = 'lake.webp';
  world(state, Array.from('bcdefghij'));
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-storyboard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audio = join(dir, 'long-note.webm');
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:a', 'libopus', audio]);
  state.media.push({ id: 'long-note', mime: 'audio/webm', provenance: 'original', duration: 20, storage: audio });
  state.anchors.push({ id: 'note-stop', eventId, sourceIds: ['c'] });
  state.recollections.push({ id: 'long-account', eventId, anchorId: 'note-stop', audioMediaId: 'long-note', text: 'This note belongs only to source C.' });
  const manifest = eventDependencies(state, eventId, 'all');
  assert.equal(manifest.storyboard.narration.startSeconds, 4);
  assert.equal(manifest.storyboard.narration.seconds, 4);
  const result = await renderFilm(manifest, dir, 'cut', fileURLToPath(new URL('../apps/web/public/media/', import.meta.url)));
  const captions = await readFile(result.captions, 'utf8');
  const starts = manifest.storyboard.frames.map(frame => captions.indexOf(frame.caption));
  assert.ok(starts.every((position, index) => position >= 0 && (!index || position > starts[index - 1])));
  for (const sourceId of manifest.storyboard.excludedSourceIds) {
    assert.equal(captions.includes(state.media.find(source => source.id === sourceId).caption), false);
  }
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', result.output], { encoding: 'utf8' }).trim());
  assert.ok(Math.abs(duration - manifest.storyboard.durationSeconds) < 0.1);
  const energy = start => {
    const samples = execFileSync('ffmpeg', ['-v', 'error', '-i', result.output, '-ss', String(start), '-map', '0:a:0', '-t', '0.25', '-f', 's16le', '-']);
    assert.ok(samples.length > 0);
    let squared = 0;
    for (let offset = 0; offset < samples.length; offset += 2) squared += samples.readInt16LE(offset) ** 2;
    return Math.sqrt(squared / (samples.length / 2));
  };
  assert.ok(energy(0) < 1, 'The note does not play before its source');
  assert.ok(energy(4) > 100, 'The note plays during its source');
  assert.ok(energy(8.5) < 1, 'The overlong note stops before the next source');
});

test('restart requires a new review for legacy films without a storyboard and preserves current reviewed films', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-storyboard-migration-'));
  const store = createStore(dir);
  let worker;
  t.after(async () => { await worker?.stop(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const project = store.create(actor, 'Legacy film test', true);
  store.update(actor, project.id, null, state => {
    const manifest = eventDependencies(state, eventId, 'all');
    const { storyboard, ...legacyManifest } = manifest;
    state.jobs = ['queued', 'ready', 'running'].map(status => ({
      id: 'legacy-' + status, eventId, lens: 'all', status, approved: true,
      manifest: legacyManifest, inputHash: digest(legacyManifest)
    }));
    state.jobs.push({ id: 'reviewed', eventId, lens: 'all', status: 'ready', approved: true, manifest, inputHash: digest(manifest) });
  });
  worker = createFilmWorker(store, dir, fileURLToPath(new URL('../apps/web/public/media/', import.meta.url)));
  await worker.stop();
  const jobs = store.read(actor, project.id).jobs;
  assert.deepEqual(jobs.map(job => job.status), ['stale', 'stale', 'failed', 'ready']);
  assert.deepEqual(jobs.filter(job => job.status === 'stale').map(job => job.approved), [false, false]);
  assert.equal(jobs.at(-1).approved, true);
  assert.ok(jobs.at(-1).manifest.storyboard);
});
