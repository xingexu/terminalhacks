import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';
import { requireCondition, uid } from '../runtime/memory.mjs';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const imageMimes = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const profileFilters = {
  natural: 'eq=contrast=1:saturation=1',
  nostalgic: 'eq=contrast=0.95:saturation=0.8:brightness=0.035,colorbalance=rs=.08:gs=.015:bs=-.055',
  documentary: 'eq=contrast=1.1:saturation=0.72',
  vivid: 'eq=contrast=1.08:saturation=1.22'
};

export async function ingest(buffer, { name, audio, dir, keepLocation = false }) {
  const id = uid();
  const prefix = join(dir, id);
  await mkdir(dir, { recursive: true });
  const hash = createHash('sha256').update(buffer).digest('hex');
  const caption = basename(name || 'Untitled source').replace(/\.[a-z0-9]{1,8}$/i, '').slice(0, 180) || 'Untitled source';
  let mime, capturedAt = null, capturedLocal = null, gps = null, storage, thumb, duration = null, playback, inspectionPath;
  try {
    const metadata = await sharp(buffer, { limitInputPixels: 50_000_000 }).metadata().catch(() => null);
    if (imageMimes[metadata?.format]) {
      mime = imageMimes[metadata.format];
      storage = prefix + '.original';
      thumb = prefix + '.jpg';
      const exif = await exifr.parse(buffer, { pick: ['DateTimeOriginal', 'OffsetTimeOriginal'], reviveValues: false }).catch(() => null);
      const raw = typeof exif?.DateTimeOriginal === 'string' ? exif.DateTimeOriginal : '';
      if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) capturedLocal = raw.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T');
      if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) && /^[+-]\d{2}:\d{2}$/.test(exif?.OffsetTimeOriginal ?? '')) {
        const timestamp = raw.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T') + exif.OffsetTimeOriginal;
        if (!Number.isNaN(Date.parse(timestamp))) capturedAt = timestamp;
      }
      if (keepLocation) {
        const coords = await exifr.gps(buffer).catch(() => null);
        if (Number.isFinite(coords?.latitude) && Number.isFinite(coords?.longitude) && Math.abs(coords.latitude) <= 90 && Math.abs(coords.longitude) <= 180) {
          gps = [coords.latitude, coords.longitude];
        }
      }
      await sharp(buffer, { limitInputPixels: 50_000_000 }).rotate().resize(1440, 1100, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(thumb);
    } else {
      const isMp4 = buffer.subarray(4, 8).toString('ascii') === 'ftyp';
      const isWebm = buffer.subarray(0, 4).toString('hex') === '1a45dfa3';
      requireCondition(isMp4 || isWebm, 400, 'UNSUPPORTED_FILE', 'Use a JPEG, PNG, WebP, MP4, or WebM file.');
      inspectionPath = prefix + (isMp4 ? '.mp4' : '.webm');
      await writeFile(inspectionPath, buffer);
      const { stdout } = await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
        'format=duration:format_tags=creation_time,location,com.apple.quicktime.location.ISO6709:stream=codec_type,width,height', '-of', 'json', inspectionPath], { timeout: 12000 });
      const probe = JSON.parse(stdout);
      const video = probe.streams?.find(stream => stream.codec_type === 'video');
      const isAudio = probe.streams?.some(stream => stream.codec_type === 'audio');
      duration = Number(probe.format?.duration);
      if (audio && !Number.isFinite(duration) && isAudio && !video) {
        playback = prefix + '.audio.mp4';
        await run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', inspectionPath,
          '-t', '121', '-vn', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', playback], { timeout: 25000 });
        const measured = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', playback], { timeout: 5000 });
        duration = Number(measured.stdout.trim());
      }
      requireCondition(Number.isFinite(duration) && duration > 0 && duration <= 120, 400, 'CLIP_LENGTH', 'Select a clip or voice note shorter than two minutes.');
      if (audio) requireCondition(isAudio && !video, 400, 'INVALID_AUDIO', 'That file is not a voice recording.');
      else requireCondition(video && video.width * video.height <= 9_437_184, 400, 'INVALID_VIDEO', 'Select a video up to 4K.');
      mime = (audio ? 'audio/' : 'video/') + (isMp4 ? 'mp4' : 'webm');
      storage = inspectionPath;
      const timestamp = probe.format?.tags?.creation_time;
      if (typeof timestamp === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) && !Number.isNaN(Date.parse(timestamp))) capturedAt = timestamp;
      if (keepLocation) {
        const location = probe.format?.tags?.['com.apple.quicktime.location.ISO6709'] || probe.format?.tags?.location;
        const coordinates = typeof location === 'string' && /^([+-]\d{2}(?:\.\d+)?)([+-]\d{3}(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\/$/.exec(location);
        if (coordinates && Math.abs(Number(coordinates[1])) <= 90 && Math.abs(Number(coordinates[2])) <= 180) {
          gps = [Number(coordinates[1]), Number(coordinates[2])];
        }
      }
      if (!audio) {
        thumb = prefix + '.jpg';
        await run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', storage, '-frames:v', '1',
          '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease', '-threads', '1', '-update', '1', thumb], { timeout: 25000 });
      }
    }
    if (storage !== inspectionPath) await writeFile(storage, buffer);
    return { id, hash, caption, mime, capturedAt, capturedLocal, gps, duration, storage, thumb, playback, provenance: 'original' };
  } catch (error) {
    await Promise.all([...new Set([storage, thumb, playback, inspectionPath].filter(Boolean))].map(path => rm(path, { force: true })));
    if (error.status) throw error;
    requireCondition(false, 400, 'DECODE_FAILED', 'We could not read this file as supported media.');
  }
}

export async function removeMedia(item) {
  await Promise.all([item.storage, item.thumb, item.playback].filter(Boolean).map(path => rm(path, { force: true })));
}

function cue(seconds, separator = ',') {
  const ms = Math.round(seconds * 1000);
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':')
    + separator + String(ms % 1000).padStart(3, '0');
}

export async function renderFilm(manifest, outputDir, outputId, demoDir) {
  const working = join(outputDir, outputId + '-work');
  const output = join(outputDir, outputId + '.mp4');
  const captions = join(outputDir, outputId + '.vtt');
  await mkdir(working, { recursive: true });
  const runFfmpeg = args => run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', ...args], { timeout: 130000 });
  try {
    const frames = manifest.storyboard.frames;
    if (!frames.length || frames.length > 8) throw new Error('Review a valid source storyboard before rendering.');
    const clips = [];
    const lines = [];
    let elapsed = 0;
    for (const [index, frame] of frames.entries()) {
      const item = manifest.media.find(item => item.id === frame.sourceId);
      const segmentSeconds = frame.seconds;
      if (!item || !Number.isFinite(segmentSeconds) || segmentSeconds < 4 || segmentSeconds > 30) throw new Error('The reviewed storyboard is invalid.');
      const name = 'clip-' + index + '.mp4';
      const image = item.mime.startsWith('image/');
      const input = item.demoFile ? join(demoDir, item.demoFile) : (image ? item.thumb : item.storage);
      const crop = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1';
      const framing = image ? crop + ",zoompan=z='min(zoom+0.00065,1.10)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=" + (segmentSeconds * 24) + ':s=1920x1080:fps=24' :
        crop + ',fps=24,tpad=stop_mode=clone:stop_duration=' + segmentSeconds;
      await runFfmpeg(['-protocol_whitelist', 'file,pipe', '-filter_threads', '2', '-i', input, '-an', '-vf',
        framing + ',' + profileFilters[manifest.profile] + ',format=yuv420p', '-t', String(segmentSeconds),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-threads', '2', join(working, name)]);
      clips.push("file '" + name + "'");
      const context = [manifest.event.placeLabel, manifest.event.startAt?.slice(0, 10)].filter(Boolean).join(' · ');
      const content = [...(index === 0 ? [[manifest.event.title, context].filter(Boolean).join(' · ')] : []), frame.caption,
        frame.provenance === 'imagined' ? 'Imagined demo imagery' : 'Original source',
        ...(frame.recollection ? ['You recalled' + (frame.recollection.excerpt ? ' (excerpt)' : '') + ': ' + frame.recollection.text] : [])]
        .map(line => line.replace(/[\r\n<>]/g, ' ')).join('\n');
      lines.push({ start: elapsed, end: elapsed + segmentSeconds, content });
      elapsed += segmentSeconds;
    }
    const list = join(working, 'list.txt');
    const subs = join(working, 'film.srt');
    await writeFile(list, clips.join('\n') + '\n');
    const textCues = separator => lines.map((line, index) => (index + 1) + '\n' + cue(line.start, separator)
      + ' --> ' + cue(line.end, separator) + '\n' + line.content + '\n').join('\n');
    await writeFile(subs, textCues(','));
    await writeFile(captions, 'WEBVTT\n\n' + textCues('.'));
    const audio = manifest.narration;
    const narration = manifest.storyboard.narration;
    if (audio && (!narration || narration.sourceId !== audio.id || !Number.isFinite(narration.startSeconds) ||
      !Number.isFinite(narration.seconds) || narration.startSeconds < 0 || narration.seconds <= 0 ||
      narration.startSeconds + narration.seconds > elapsed)) throw new Error('Review valid narration timing before rendering.');
    const audioInput = audio ? ['-i', audio.playback || audio.storage] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
    await runFfmpeg(['-f', 'concat', '-safe', '1', '-i', list, ...audioInput,
      '-i', subs, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:s:0', ...(audio ? ['-af',
        `atrim=duration=${narration.seconds},asetpts=PTS-STARTPTS,adelay=${Math.round(narration.startSeconds * 1000)}:all=1,apad`,
        '-ar', '48000', '-ac', '2'] : []), '-t', String(elapsed),
      '-c:v', 'copy', '-c:a', 'aac', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-movflags', '+faststart', output]);
    return { output, captions };
  } catch (error) {
    await Promise.all([rm(output, { force: true }), rm(captions, { force: true })]);
    throw error;
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}
