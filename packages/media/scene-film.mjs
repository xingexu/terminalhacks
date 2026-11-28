import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { requireCondition as check, uid } from '../runtime/memory.mjs';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const durationValid = value => Number.isFinite(value) && value >= 30 && value <= 60;

export async function storeSceneRecording(buffer, { dir, durationSeconds }) {
  check(Buffer.isBuffer(buffer) && buffer.length > 0, 400, 'SCENE_RECORDING_FILE', 'Record the scene before uploading it.');
  check(buffer.length <= 48 * 1024 ** 2, 413, 'SCENE_RECORDING_SIZE', 'Record a scene film smaller than 48 MB.');
  check(durationValid(durationSeconds), 400, 'SCENE_RECORDING_LENGTH', 'Record a camera path between 30 and 60 seconds.');
  const mp4 = buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  const webm = buffer.subarray(0, 4).toString('hex') === '1a45dfa3';
  check(mp4 || webm, 400, 'SCENE_RECORDING_FILE', 'Use a WebM or MP4 scene recording.');
  const storage = join(dir, uid() + '.scene.' + (mp4 ? 'mp4' : 'webm'));
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(storage, buffer);
    const { stdout } = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate:stream_tags=rotate:stream_side_data=rotation',
      '-of', 'json', storage], { timeout: 12000, maxBuffer: 256 * 1024 });
    const probe = JSON.parse(stdout);
    const videos = probe.streams?.filter(stream => stream.codec_type === 'video') || [];
    const video = videos[0];
    check(videos.length === 1 && probe.streams.length <= 2 && probe.streams.every(stream => ['video', 'audio'].includes(stream.codec_type)) &&
      ['h264', 'vp8', 'vp9'].includes(video?.codec_name) && video.width === 1920 && video.height === 1080 &&
      [undefined, 'N/A', '1:1'].includes(video.sample_aspect_ratio) && !Number(video.tags?.rotate || 0) &&
      !(video.side_data_list || []).some(item => Number(item.rotation || 0)),
    400, 'SCENE_RECORDING_VIDEO', 'Record one unrotated 1920 × 1080 scene video.');
    const [numerator, denominator] = (video.avg_frame_rate || '0/0').split('/').map(Number);
    const rate = numerator / denominator;
    check(!Number.isFinite(rate) || (rate > 0 && rate <= 60), 400, 'SCENE_RECORDING_VIDEO', 'Record the scene at up to 60 frames per second.');
    const metadataDuration = Number(probe.format?.duration);
    check(!Number.isFinite(metadataDuration) || Math.abs(metadataDuration - durationSeconds) <= 1,
      400, 'SCENE_RECORDING_LENGTH', 'The recording does not match the reviewed camera path. Record it again.');
    // Browser WebM often has no duration. Decode a bounded interval before accepting its timestamps.
    const decoded = await run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-xerror', '-nostats', '-progress', 'pipe:1',
      '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', storage, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', 'setpts=PTS-STARTPTS', '-t', String(durationSeconds + 1.5), '-frames:v', String(Math.ceil((durationSeconds + 1.5) * 60) + 1),
      '-f', 'null', '-'], { timeout: 90000, maxBuffer: 1024 * 1024 });
    const times = [...decoded.stdout.matchAll(/^out_time_us=(\d+)$/gm)];
    const measured = Number(times.at(-1)?.[1]) / 1_000_000;
    check(Number.isFinite(measured) && Math.abs(measured - durationSeconds) <= 1,
      400, 'SCENE_RECORDING_LENGTH', 'The recording does not match the reviewed camera path. Record it again.');
    return { storage, contentHash: createHash('sha256').update(buffer).digest('hex') };
  } catch (error) {
    await rm(storage, { force: true });
    if (error.status) throw error;
    check(false, 400, 'SCENE_RECORDING_DECODE', 'This scene recording could not be decoded. Record it again.');
  }
}

function cue(seconds, separator) {
  const ms = Math.round(seconds * 1000);
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60]
    .map(value => String(value).padStart(2, '0')).join(':') + separator + String(ms % 1000).padStart(3, '0');
}

export async function renderSceneFilm(manifest, outputDir, outputId) {
  const working = join(outputDir, outputId + '-scene-work');
  const output = join(outputDir, outputId + '.mp4');
  const captions = join(outputDir, outputId + '.vtt');
  await mkdir(working, { recursive: true });
  try {
    const recording = manifest.sceneRecording;
    const storyboard = manifest.storyboard;
    check(recording?.storage && durationValid(recording.durationSeconds) && recording.width === 1920 && recording.height === 1080 &&
      ['imagined', 'reconstructed'].includes(recording.provenance) && storyboard?.kind === 'scene_recording' &&
      storyboard.frames?.length > 0 && storyboard.frames.length <= 8,
    400, 'SCENE_RECORDING_PLAN', 'Review a current scene film before rendering.');
    const duration = recording.durationSeconds;
    let elapsed = 0;
    const lines = storyboard.frames.map((frame, index) => {
      check(Number.isFinite(frame.seconds) && frame.seconds > 0 && frame.seconds <= 60 &&
        manifest.media.some(item => item.id === frame.sourceId), 400, 'SCENE_RECORDING_PLAN', 'Review valid source references before rendering.');
      const context = [manifest.event.placeLabel, manifest.event.startAt?.slice(0, 10)].filter(Boolean).join(' · ');
      const content = [...(index === 0 ? [[manifest.event.title, context].filter(Boolean).join(' · '), recording.worldTitle] : []),
        'Virtual camera recording · ' + (recording.provenance === 'imagined' ? 'Imagined world' : 'Reconstructed world'),
        'Source reference: ' + frame.caption + ' · ' + (frame.provenance === 'imagined' ? 'Imagined imagery' : 'Original source'),
        ...(frame.recollection ? ['You recalled' + (frame.recollection.excerpt ? ' (excerpt)' : '') + ': ' + frame.recollection.text] : [])]
        .filter(Boolean).map(line => String(line).replace(/[\r\n<>]/g, ' ')).join('\n');
      const line = { start: elapsed, end: elapsed + frame.seconds, content };
      elapsed += frame.seconds;
      return line;
    });
    check(Math.abs(elapsed - duration) < 0.01, 400, 'SCENE_RECORDING_PLAN', 'The source-reference timing does not match this recording.');
    const audio = manifest.narration;
    const narration = storyboard.narration;
    check(!audio || (narration?.sourceId === audio.id && Number.isFinite(narration.startSeconds) && Number.isFinite(narration.seconds) &&
      narration.startSeconds >= 0 && narration.seconds > 0 && narration.startSeconds + narration.seconds <= duration + 1e-6),
    400, 'SCENE_RECORDING_PLAN', 'Review valid narration timing before rendering.');
    const textCues = separator => lines.map((line, index) => (index + 1) + '\n' + cue(line.start, separator) + ' --> ' + cue(line.end, separator) + '\n' + line.content + '\n').join('\n');
    const subtitles = join(working, 'film.srt');
    await writeFile(subtitles, textCues(','));
    await writeFile(captions, 'WEBVTT\n\n' + textCues('.'));
    const audioInput = audio ? ['-protocol_whitelist', 'file,pipe', '-i', audio.playback || audio.storage] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
    await run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-xerror', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', recording.storage,
      ...audioInput, '-i', subtitles, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:s:0',
      '-vf', 'setpts=PTS-STARTPTS,fps=24,tpad=stop_mode=clone:stop_duration=1.1,setsar=1,format=yuv420p',
      ...(audio ? ['-af', `atrim=duration=${narration.seconds},asetpts=PTS-STARTPTS,adelay=${Math.round(narration.startSeconds * 1000)}:all=1,apad`] : []),
      '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2',
      '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
      '-map_metadata', '-1', '-map_metadata:s', '-1', '-movflags', '+faststart', output], { timeout: 130000, maxBuffer: 1024 * 1024 });
    return { output, captions };
  } catch (error) {
    await Promise.all([rm(output, { force: true }), rm(captions, { force: true })]);
    throw error;
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}
