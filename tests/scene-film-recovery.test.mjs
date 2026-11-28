import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../apps/api/store.mjs';
import { createFilmWorker, savePreview } from '../apps/api/service.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-scene-recovery-'));
  const store = createStore(dir);
  const actor = 'recovery-test';
  const project = store.create(actor, 'Recovery fixture');
  const files = join(dir, 'projects', project.id);
  await mkdir(files, { recursive: true });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, actor, project, files };
}

test('scene-film review allows fifteen minutes while other previews retain five minutes', () => {
  const state = { previews: {} };
  for (const [kind, minutes] of [['scene-film', 15], ['film', 5], ['command', 5], ['world', 5]]) {
    const start = Date.now();
    const result = savePreview(state, { kind, actor: 'owner', diff: {} });
    const end = Date.now();
    const expires = Date.parse(result.expires);
    assert.ok(expires >= start + minutes * 60_000 && expires <= end + minutes * 60_000);
    assert.equal(state.previews[result.previewToken].expires, expires);
  }
});

test('startup removes orphan scene inputs and interrupted outputs while preserving queued inputs, ready films and original sources', async t => {
  const { dir, store, actor, project, files } = await setup(t);
  const names = ['orphan.scene.webm', 'orphan.scene.mp4', 'queued.scene.webm', 'running.scene.mp4',
    'running.mp4', 'running.vtt', 'montage.mp4', 'montage.vtt', 'failed.mp4', 'failed.vtt', 'cancelled.mp4', 'cancelled.vtt', 'ready.mp4', 'ready.vtt', 'original.mp4', 'original.jpg'];
  await Promise.all(names.map(name => writeFile(join(files, name), name)));
  for (const name of ['running-scene-work', 'montage-work', 'failed-scene-work', 'cancelled-scene-work']) {
    await mkdir(join(files, name));
    await writeFile(join(files, name, 'film.srt'), 'Private interrupted subtitle');
  }
  const deletedProjectFiles = join(dir, 'projects', 'deleted-project');
  await mkdir(deletedProjectFiles);
  await writeFile(join(deletedProjectFiles, 'orphan.scene.webm'), 'Private orphan');
  store.update(actor, project.id, null, state => {
    state.jobs = [
      { id: 'queued', status: 'queued', manifest: { storyboard: {}, sceneRecording: { storage: join(files, 'queued.scene.webm') } } },
      { id: 'running', status: 'running', approved: true, output: join(files, 'running.mp4'), captions: join(files, 'running.vtt'), contentHash: 'old',
        manifest: { storyboard: {}, sceneRecording: { storage: join(files, 'running.scene.mp4') } } },
      { id: 'montage', status: 'running', manifest: { storyboard: {} } },
      { id: 'ready', status: 'ready', approved: true, output: join(files, 'ready.mp4'), captions: join(files, 'ready.vtt'), manifest: { storyboard: {} } },
      { id: 'failed', status: 'failed', manifest: { storyboard: {} } },
      { id: 'cancelled', status: 'stale', approved: false }
    ];
  });
  const worker = createFilmWorker(store, dir, dir);
  await worker.stop();
  assert.deepEqual((await readdir(files)).sort(), ['original.jpg', 'original.mp4', 'queued.scene.webm', 'ready.mp4', 'ready.vtt']);
  assert.deepEqual(await readdir(deletedProjectFiles), []);
  const state = store.read(actor, project.id);
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].manifest.sceneRecording.storage, join(files, 'queued.scene.webm'));
  assert.equal(state.jobs[1].status, 'failed');
  assert.equal(state.jobs[1].approved, false);
  assert.equal(state.jobs[1].manifest.sceneRecording.storage, undefined);
  assert.equal(state.jobs[1].output, undefined);
  assert.equal(state.jobs[1].captions, undefined);
  assert.equal(state.jobs[1].contentHash, undefined);
  assert.equal(state.jobs[2].status, 'failed');
  assert.equal(state.jobs[3].status, 'ready');
  assert.equal(state.jobs[3].approved, true);
  assert.equal(await readFile(join(files, 'ready.mp4'), 'utf8'), 'ready.mp4');
});

test('an upload created after the startup snapshot is not removed by orphan recovery', async t => {
  const { dir, store, files } = await setup(t);
  const worker = createFilmWorker(store, dir, dir);
  await writeFile(join(files, 'new-upload.scene.webm'), 'In-flight upload');
  await worker.stop();
  assert.equal(await readFile(join(files, 'new-upload.scene.webm'), 'utf8'), 'In-flight upload');
});

test('stale input cleanup tolerates project deletion while the file is being removed', async t => {
  const { dir, store, actor, project, files } = await setup(t);
  const raw = join(files, 'stale.scene.webm');
  await writeFile(raw, 'Stale private input');
  store.update(actor, project.id, null, state => {
    state.jobs = [{ id: 'stale', status: 'stale', manifest: { storyboard: {}, sceneRecording: { storage: raw } } }];
  });
  let reads = 0;
  let deleted = false;
  const wrapped = { ...store, all() {
    const projects = store.all();
    if (++reads === 2) queueMicrotask(() => { store.delete(actor, project.id); deleted = true; });
    return projects;
  } };
  const worker = createFilmWorker(wrapped, dir, dir);
  for (let i = 0; i < 100 && !deleted; i++) await delay(1);
  assert.equal(deleted, true, 'Deletion ran during the asynchronous stale-input sweep');
  await worker.stop();
  assert.equal(store.read(actor, project.id, false), undefined);
  assert.deepEqual(await readdir(files), []);
});
