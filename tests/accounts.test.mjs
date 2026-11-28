import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/api/server.mjs';

const credentials = { email: 'walker@example.test', password: 'test passphrase for a local fixture' };
const cookieFrom = reply => reply.headers['set-cookie']?.split(';')[0];

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'everwhere-accounts-'));
  let app = await createApp({ dataDir, serveWeb: false });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    async restart() {
      await app.close();
      app = await createApp({ dataDir, serveWeb: false });
    },
    async request(path, { cookie, body, status = 200, headers } = {}) {
      const reply = await app.inject({
        method: body === undefined ? 'GET' : 'POST',
        url: '/v1' + path,
        headers: { ...(cookie && { cookie }), ...headers },
        payload: body
      });
      assert.equal(reply.statusCode, status, reply.body);
      return reply;
    }
  };
}

test('registering preserves the guest project, rotates the browser session, and survives restart', async t => {
  const { request, restart } = await fixture(t);
  const guest = await request('/bootstrap');
  const guestCookie = cookieFrom(guest);
  const project = (await request('/projects', { cookie: guestCookie, body: { title: 'My memory' }, status: 201 })).json().data;
  const path = '/projects/' + project.id + '/snapshot';
  const registered = await request('/auth/register', {
    cookie: guestCookie, body: { ...credentials, email: ' WALKER@example.test ' }
  });
  const account = { account: { email: credentials.email } };
  assert.deepEqual(registered.json().data, account);
  const signedIn = cookieFrom(registered);
  assert.ok(signedIn && signedIn !== guestCookie);
  assert.match(registered.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
  await request(path, { cookie: guestCookie, status: 401 });
  await restart();
  assert.deepEqual((await request('/auth/session', { cookie: signedIn })).json().data, account);
  assert.equal((await request(path, { cookie: signedIn })).json().data.title, 'My memory');
  const signedOut = await request('/auth/logout', { cookie: signedIn, body: {} });
  assert.deepEqual(signedOut.json().data, { account: null });
  await request(path, { cookie: signedIn, status: 401 });
  await request(path, { cookie: cookieFrom(signedOut), status: 404 });
  const newDevice = await request('/auth/login', { body: credentials });
  const otherDevice = await request('/auth/login', { body: credentials });
  await request('/auth/logout', { cookie: cookieFrom(newDevice), body: {} });
  await request(path, { cookie: cookieFrom(otherDevice) });
});

test('login restores the account workspace and sign-out returns to this browser’s previous guest project', async t => {
  const { request } = await fixture(t);
  const registered = await request('/auth/register', { body: credentials });
  const accountCookie = cookieFrom(registered);
  const accountProject = (await request('/bootstrap', { cookie: accountCookie })).json().data[0];
  const guest = await request('/bootstrap');
  const guestProject = guest.json().data[0];
  const guestCookie = cookieFrom(guest);
  const account = await request('/auth/login', { body: credentials, cookie: guestCookie });
  const activeCookie = cookieFrom(account);
  const path = id => '/projects/' + id + '/snapshot';
  await request(path(accountProject.id), { cookie: activeCookie });
  await request(path(guestProject.id), { cookie: activeCookie, status: 404 });
  await request(path(guestProject.id), { cookie: guestCookie, status: 401 });
  const restored = cookieFrom(await request('/auth/logout', { body: {}, cookie: activeCookie }));
  await request(path(guestProject.id), { cookie: restored });
  await request(path(accountProject.id), { cookie: restored, status: 404 });
});

test('invalid credentials and concurrent duplicate registrations leave the existing account intact', async t => {
  const { request } = await fixture(t);
  assert.deepEqual((await request('/auth/session')).json().data, { account: null });
  await request('/auth/register', { body: { ...credentials, password: 'short' }, status: 400 });
  await request('/auth/register', { body: { ...credentials, email: 'bad address' }, status: 400 });
  const registered = await request('/auth/register', { body: credentials });
  const attempts = await Promise.all([
    request('/auth/register', { body: credentials, status: 409 }),
    request('/auth/register', { body: { ...credentials, email: credentials.email.toUpperCase() }, status: 409 })
  ]);
  assert.ok(attempts.every(reply => !cookieFrom(reply)));
  const wrong = await request('/auth/login', { body: { ...credentials, password: 'incorrect' }, status: 401 });
  const unknown = await request('/auth/login', { body: { ...credentials, email: 'unknown@example.test' }, status: 401 });
  assert.deepEqual(wrong.json(), unknown.json());
  await request('/auth/login', { body: credentials, headers: { origin: 'https://elsewhere.test' }, status: 403 });
  await request('/auth/logout', { body: {}, cookie: cookieFrom(registered), headers: { authorization: 'Bearer unrelated' }, status: 403 });
  assert.deepEqual((await request('/auth/session', { cookie: cookieFrom(registered) })).json().data.account, { email: credentials.email });
});
