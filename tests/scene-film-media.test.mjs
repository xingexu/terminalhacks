import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { storeSceneRecording, renderSceneFilm } from '../packages/media/scene-film.mjs';

const ffmpeg = args => execFileSync(process.env.FFMPEG || 'ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...args]);
const probe = file => JSON.parse(execFileSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
const temporary = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-scene-film-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('scene recording boundaries reject unsupported, oversized, wrong-resolution and wrong-length uploads without retained files', async t => {
  const dir = await temporary(t);
  const stored = join(dir, 'stored');
  const reject = async (bytes, code, durationSeconds = 30) => {
    await assert.rejects(storeSceneRecording(bytes, { dir: stored, durationSeconds }), error => error.code === code);
    assert.deepEqual(await readdir(stored).catch(() => []), []);
  };
  await reject(Buffer.from('not a scene'), 'SCENE_RECORDING_FILE');
  await reject(Buffer.alloc(48 * 1024 ** 2 + 1), 'SCENE_RECORDING_SIZE');
  await reject(Buffer.from('1234ftypbad'), 'SCENE_RECORDING_LENGTH', 29);
  await reject(Buffer.from('1234ftypbad'), 'SCENE_RECORDING_DECODE');
  const low = join(dir, 'low.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=1:d=30', '-c:v', 'libx264', '-preset', 'ultrafast', low]);
  await reject(await readFile(low), 'SCENE_RECORDING_VIDEO');
  const short = join(dir, 'short.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=1:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', short]);
  await reject(await readFile(short), 'SCENE_RECORDING_LENGTH');
});

test('streaming browser-style WebM has its missing duration measured and overlong data rejected', async t => {
  const dir = await temporary(t);
  const stored = join(dir, 'stored');
  const webm = join(dir, 'stream.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=2:d=30', '-c:v', 'libvpx', '-deadline', 'realtime',
    '-cpu-used', '8', '-b:v', '200k', '-threads', '2', '-live', '1', webm]);
  assert.equal(probe(webm).format.duration, undefined, 'Fixture has the missing duration produced by a streaming recorder');
  const bytes = await readFile(webm);
  const result = await storeSceneRecording(bytes, { dir: stored, durationSeconds: 30 });
  assert.equal(result.contentHash, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(result.storage), bytes);
  const long = join(dir, 'long.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=2:d=34', '-c:v', 'libvpx', '-deadline', 'realtime',
    '-cpu-used', '8', '-b:v', '200k', '-threads', '2', '-live', '1', long]);
  await assert.rejects(storeSceneRecording(await readFile(long), { dir: stored, durationSeconds: 30 }), error => error.code === 'SCENE_RECORDING_LENGTH');
  assert.equal((await readdir(stored)).length, 1, 'Only the accepted recording remains');
});

test('scene film keeps moving 1080p footage, uses reviewed captions and confines narration while discarding uploaded audio', async t => {
  const dir = await temporary(t);
  const captured = join(dir, 'captured.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=12:d=30', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-threads', '2', '-c:a', 'aac',
    '-metadata:s:v:0', 'handler_name=Private capture metadata', '-shortest', captured]);
  const recording = await storeSceneRecording(await readFile(captured), { dir: join(dir, 'stored'), durationSeconds: 30 });
  const voice = join(dir, 'voice.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:a', 'libopus', '-metadata:s:a:0', 'title=Private note metadata', voice]);
  const frames = [{ sourceId: 'a', caption: 'Arrival', seconds: 15, provenance: 'original' },
    { sourceId: 'b', caption: 'Beside the lake', seconds: 15, provenance: 'original',
      recollection: { text: 'We watched the boats.', excerpt: false } }];
  const manifest = {
    event: { title: 'Harbour memory', placeLabel: 'Toronto', startAt: '2026-11-27T20:00:00Z' },
    media: [{ id: 'a' }, { id: 'b' }],
    narration: { id: 'voice', storage: voice },
    storyboard: { kind: 'scene_recording', frames, narration: { sourceId: 'voice', startSeconds: 15, seconds: 3 } },
    sceneRecording: { ...recording, worldId: 'world', worldTitle: 'Reviewed harbour world', provenance: 'imagined', durationSeconds: 30, width: 1920, height: 1080 }
  };
  const result = await renderSceneFilm(manifest, dir, 'scene-film');
  const info = probe(result.output);
  assert.ok(!JSON.stringify(info).includes('Private '), 'Input stream metadata is not copied into the film');
  const video = info.streams.find(stream => stream.codec_type === 'video');
  assert.deepEqual([video.width, video.height, video.codec_name, video.avg_frame_rate], [1920, 1080, 'h264', '24/1']);
  assert.equal(info.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
  assert.ok(Math.abs(Number(info.format.duration) - 30) < 0.1);
  const pixels = at => ffmpeg(['-ss', String(at), '-i', result.output, '-frames:v', '1', '-vf', 'scale=32:18', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.notDeepEqual(pixels(1), pixels(20), 'Actual camera video retains motion');
  const energy = at => {
    const bytes = ffmpeg(['-ss', String(at), '-i', result.output, '-map', '0:a:0', '-t', '0.25', '-f', 's16le', '-']);
    assert.ok(bytes.length > 0);
    let total = 0;
    for (let i = 0; i < bytes.length; i += 2) total += bytes.readInt16LE(i) ** 2;
    return Math.sqrt(total / (bytes.length / 2));
  };
  assert.ok(energy(1) < 1, 'Uploaded source audio is discarded');
  assert.ok(energy(15.5) > 100, 'Reviewed narration plays in its interval');
  assert.ok(energy(19) < 1, 'Narration does not overrun its reviewed interval');
  const captions = await readFile(result.captions, 'utf8');
  assert.ok(captions.includes('Virtual camera recording · Imagined world'));
  assert.ok(captions.includes('Reviewed harbour world'));
  assert.ok(captions.includes('Source reference: Arrival · Original source'));
  assert.ok(captions.includes('00:00:15.000 --> 00:00:30.000'));
  assert.ok(captions.includes('You recalled: We watched the boats.'));
  assert.ok(!captions.includes(recording.storage));
  assert.equal((await readdir(dir)).some(file => file.endsWith('-scene-work')), false);
  await assert.rejects(renderSceneFilm({ ...manifest, storyboard: { ...manifest.storyboard, narration: { sourceId: 'voice', startSeconds: 29, seconds: 3 } } }, dir, 'bad-film'),
    error => error.code === 'SCENE_RECORDING_PLAN');
  assert.equal((await readdir(dir)).some(file => file.startsWith('bad-film')), false);
});
