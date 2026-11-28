import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pictures = /\.(jpe?g|png|webp|heic|heif|tiff?)$/i;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

async function pictureFiles(dir) {
  const names = (await readdir(dir)).filter(name => pictures.test(name) && !name.startsWith('.')).sort();
  return names;
}

/** A folder whose subfolders are events. Used for tests, and for libraries exported from Photos. */
function folderLibrary(root) {
  return {
    kind: 'folder',
    async events() {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => {
        throw fail(503, 'PHOTO_LIBRARY_UNAVAILABLE', 'The photo library folder could not be read.');
      });
      const events = [];
      for (const entry of entries.filter(item => item.isDirectory() && !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
        events.push({ id: entry.name, name: entry.name, count: (await pictureFiles(join(root, entry.name))).length });
      }
      return events;
    },
    async photos(event, limit) {
      const dir = join(root, event.id);
      const files = [];
      for (const name of (await pictureFiles(dir)).slice(0, limit)) {
        if ((await stat(join(dir, name))).size <= 48 * 1024 ** 2) files.push({ name, buffer: await readFile(join(dir, name)) });
      }
      return files;
    }
  };
}

// JavaScript for Automation, run by osascript. The first call makes macOS ask whether this process may control Photos.
const listScript = `const app = Application('Photos');
JSON.stringify(app.albums().map(album => ({ id: album.id(), name: album.name(), count: album.mediaItems.length })));`;
const exportScript = `function run(argv) {
  const app = Application('Photos');
  const items = app.albums.byId(argv[0]).mediaItems().slice(0, Number(argv[2]));
  if (items.length) app.export(items, { to: Path(argv[1]), usingOriginals: false });
  return String(items.length);
}`;

/** The Photos app on this Mac. Albums are treated as events. */
function applePhotos(execute = run) {
  const script = async (source, args = [], timeout = 60_000) => {
    try {
      return (await execute('osascript', ['-l', 'JavaScript', '-e', source, ...args], { timeout, maxBuffer: 8 * 1024 ** 2 })).stdout.trim();
    } catch (error) {
      const detail = String(error.stderr || error.message || '');
      if (/-1743|not authori[sz]ed|not allowed/i.test(detail)) {
        throw fail(403, 'PHOTO_LIBRARY_DENIED', 'macOS has not allowed Everwhere to use Photos. Open System Settings, Privacy & Security, Automation, and allow Photos for the app running Everwhere.');
      }
      if (error.killed) throw fail(504, 'PHOTO_LIBRARY_TIMEOUT', 'Photos took too long to answer. Check for a permission prompt on this Mac, then try again.');
      throw fail(503, 'PHOTO_LIBRARY_UNAVAILABLE', 'The Photos app could not be reached on this Mac.');
    }
  };
  return {
    kind: 'apple-photos',
    async events() {
      try { return JSON.parse(await script(listScript)).filter(item => item.count > 0); }
      catch (error) { throw error.status ? error : fail(503, 'PHOTO_LIBRARY_UNAVAILABLE', 'Photos returned an unreadable list of albums.'); }
    },
    async photos(event, limit) {
      const dir = await mkdtemp(join(tmpdir(), 'everwhere-photos-'));
      try {
        await script(exportScript, [event.id, dir, String(limit)], 180_000);
        const files = [];
        for (const name of await pictureFiles(dir)) {
          if ((await stat(join(dir, name))).size <= 48 * 1024 ** 2) files.push({ name, buffer: await readFile(join(dir, name)) });
        }
        return files;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}

/** No library on this machine: every request explains why. */
function noLibrary() {
  const unavailable = async () => {
    throw fail(503, 'PHOTO_LIBRARY_UNAVAILABLE', 'Photo library access needs Everwhere to run on a Mac with the Photos app, or EVERWHERE_PHOTO_LIBRARY set to a folder of event folders.');
  };
  return { kind: 'none', events: unavailable, photos: unavailable };
}

export function createPhotoLibrary({ folder = process.env.EVERWHERE_PHOTO_LIBRARY, platform = process.platform, execute } = {}) {
  if (folder) return folderLibrary(folder);
  return platform === 'darwin' ? applePhotos(execute) : noLibrary();
}

const words = value => String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Match what someone said ("the cottage weekend") to one event name. */
export function findEvent(events, query) {
  const wanted = words(query);
  if (!wanted.length) return null;
  const phrase = wanted.join(' ');
  const scored = events.map(event => {
    const name = words(event.name);
    const joined = name.join(' ');
    const shared = wanted.filter(word => name.includes(word)).length;
    return { event, score: joined === phrase ? 100 : joined.includes(phrase) || phrase.includes(joined) ? 50 + shared : shared };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  // Two events that fit equally well are a question for the person, not a guess.
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].event;
}
