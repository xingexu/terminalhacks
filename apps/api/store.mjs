import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createMemory, digest, requireCondition, uid } from '../../packages/runtime/memory.mjs';

export function createStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'everwhere.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS browser_sessions (
      token TEXT PRIMARY KEY, actor TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_actor ON projects(actor);
    CREATE TABLE IF NOT EXISTS pairings (
      token TEXT PRIMARY KEY, actor TEXT NOT NULL, project TEXT NOT NULL, expires INTEGER NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(pairings)').all().some(column => column.name === 'last_seen')) {
    db.exec('ALTER TABLE pairings ADD COLUMN last_seen INTEGER');
  }
  const updates = new EventEmitter();
  updates.setMaxListeners(0);
  const generateToken = () => randomBytes(32).toString('base64url');
  const getProject = db.prepare('SELECT * FROM projects WHERE id = ? AND actor = ?');
  const saveProject = db.prepare('UPDATE projects SET title = ?, state = ? WHERE id = ? AND actor = ?');
  const insertProject = db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)');
  const decode = row => row && JSON.parse(row.state);

  const store = {
    newBrowser() {
      const token = generateToken();
      const actor = uid();
      const expires = Date.now() + 30 * 86400_000;
      db.prepare('INSERT INTO browser_sessions VALUES (?, ?, ?)').run(digest(token), actor, expires);
      return { token, actor, expires };
    },
    browser(token) {
      if (!token || token.length > 200) return null;
      return db.prepare('SELECT actor, expires FROM browser_sessions WHERE token = ? AND expires > ?')
        .get(digest(token), Date.now()) ?? null;
    },
    pair(actor, project) {
      store.read(actor, project);
      const token = generateToken();
      const expires = Date.now() + 2 * 3600_000;
      db.prepare('DELETE FROM pairings WHERE actor = ? AND project = ?').run(actor, project);
      db.prepare('INSERT INTO pairings (token, actor, project, expires) VALUES (?, ?, ?, ?)').run(digest(token), actor, project, expires);
      return { token, expires: new Date(expires).toISOString() };
    },
    pairing(token) {
      if (!token || token.length > 200) return null;
      return db.prepare('SELECT actor, project, expires FROM pairings WHERE token = ? AND expires > ?')
        .get(digest(token), Date.now()) ?? null;
    },
    revokePair(actor, project) {
      db.prepare('DELETE FROM pairings WHERE actor = ? AND project = ?').run(actor, project);
    },
    pairingStatus(actor, project) {
      store.read(actor, project);
      const row = db.prepare('SELECT expires, last_seen FROM pairings WHERE actor = ? AND project = ?').get(actor, project);
      return { active: Boolean(row && row.expires > Date.now()), expires: row?.expires ?? null, lastSeen: row?.last_seen ?? null };
    },
    touchPair(token) {
      db.prepare('UPDATE pairings SET last_seen = ? WHERE token = ? AND expires > ?').run(Date.now(), digest(token), Date.now());
    },
    create(actor, title, demo = false) {
      const id = uid();
      insertProject.run(id, actor, title, JSON.stringify(createMemory(title, demo)));
      return { id, title, demo };
    },
    list(actor) {
      return db.prepare('SELECT id, title, state FROM projects WHERE actor = ? ORDER BY rowid').all(actor)
        .map(row => ({ id: row.id, title: row.title, demo: decode(row).demo }));
    },
    read(actor, id, required = true) {
      const state = decode(getProject.get(id, actor));
      requireCondition(state || !required, 404, 'PROJECT_NOT_FOUND', 'That private project is unavailable.');
      return state;
    },
    update(actor, id, kind, fn) {
      db.exec('BEGIN IMMEDIATE');
      let state, data, signal;
      try {
        state = store.read(actor, id);
        const before = JSON.stringify(state);
        data = fn(state);
        if (before !== JSON.stringify(state)) {
          if (kind) {
            state.seq += 1;
            signal = { seq: state.seq, kind, projectId: id, revision: state.revision, data: {} };
          }
          saveProject.run(state.title, JSON.stringify(state), id, actor);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      if (signal) updates.emit(id, signal);
      return { state, data };
    },
    delete(actor, project) {
      db.exec('BEGIN IMMEDIATE');
      try {
        store.read(actor, project);
        store.revokePair(actor, project);
        db.prepare('DELETE FROM projects WHERE id = ? AND actor = ?').run(project, actor);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      updates.emit(project, { kind: 'project.deleted', projectId: project });
    },
    all() {
      return db.prepare('SELECT id, actor, state FROM projects ORDER BY rowid').all()
        .map(row => ({ id: row.id, actor: row.actor, state: decode(row) }));
    },
    subscribe(id, callback) {
      updates.on(id, callback);
      return () => updates.off(id, callback);
    },
    close() { db.close(); }
  };
  return store;
}
