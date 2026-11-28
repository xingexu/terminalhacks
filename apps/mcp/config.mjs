import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const environment = ['EVERWHERE_API', 'EVERWHERE_PROJECT', 'EVERWHERE_PAIRING_TOKEN'];
const fields = ['api', 'project', 'token'];
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
const defaultOrigin = 'http://127.0.0.1:4173';
const setup = { error: 'EVERWHERE_SETUP_REQUIRED' };
const unsafe = { error: 'EVERWHERE_CONFIG_UNSAFE' };
const invalid = { error: 'EVERWHERE_CONFIG_INVALID' };

export const configPath = () => join(homedir(), '.config', 'everwhere', 'voiceos.json');

function settings(origin, project, token) {
  const api = URL.canParse(origin) ? new URL(origin) : null;
  const safe = api && !api.username && !api.password &&
    (api.protocol === 'https:' || (api.protocol === 'http:' && loopbackHosts.includes(api.hostname)));
  return safe && project && token ? { api, project, token } : null;
}

function readPrivate(file, uid) {
  let folder;
  try { folder = lstatSync(dirname(file)); }
  catch (error) { return error.code === 'ENOENT' ? setup : unsafe; }
  if (!folder.isDirectory() || folder.uid !== uid || folder.mode & 0o022) return unsafe;
  let fd;
  // O_NOFOLLOW refuses a symlinked file; O_NONBLOCK keeps a planted FIFO from hanging the server.
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return error.code === 'ENOENT' ? setup : unsafe; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== uid || info.mode & 0o077) return unsafe;
    if (info.size > 4096) return invalid;
    return { text: readFileSync(fd, 'utf8') };
  } finally { closeSync(fd); }
}

// Returns { api, project, token } or { error }. Errors never include file contents or secrets.
export function loadConfig({ env = process.env, file = configPath(), uid = process.getuid?.() } = {}) {
  // Any EVERWHERE_* variable selects environment setup, so a file token is never sent to an environment-chosen origin.
  if (environment.some(key => env[key] !== undefined)) {
    return settings(env.EVERWHERE_API || defaultOrigin, env.EVERWHERE_PROJECT, env.EVERWHERE_PAIRING_TOKEN) ?? setup;
  }
  if (uid === undefined) return setup; // shortcut: no POSIX owner or mode bits (Windows), so only environment setup works there.
  const read = readPrivate(file, uid);
  if (read.error) return read;
  let value;
  try { value = JSON.parse(read.text); } catch { return invalid; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every(key => fields.includes(key))) return invalid;
  const values = [value.api ?? defaultOrigin, value.project, value.token];
  if (!values.every(item => typeof item === 'string' && item.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(item))) return invalid;
  return settings(...values) ?? invalid;
}
