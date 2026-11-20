import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWorkspaceServer } from '../server.mjs';
import { sessionHeaders } from './session-fixture.mjs';

async function listen(t, options) {
  const server = createWorkspaceServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return async (path, method = 'GET', input, session, headers = {}) => {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const combined = { Origin: origin, 'Content-Type': 'application/json', ...session, ...headers };
    // Raw HTTP can model the trusted reverse proxy preserving the public Host header.
    if (!headers.Host) return fetch(origin + path, { method, body, headers: combined });
    return new Promise((resolve, reject) => {
      const req = request(origin + path, { method, headers: combined }, async res => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }));
        } catch (error) { reject(error); }
      });
      req.on('error', reject);
      req.end(body);
    });
  };
}

const owner = { username: 'owner', password: 'local-owner-test' };
const member = { username: 'speaker', password: 'local-user-test' };

test('private IP deployment accepts the direct HTTP address and preserves same-origin sessions', async t => {
  assert.throws(() => createWorkspaceServer({ database: ':memory:', origin: 'http://203.0.113.10:14003' }), /VOICE_STUDIO_ORIGIN/);
  const origin = 'http://192.168.4.2:14003';
  const http = await listen(t, { database: ':memory:', setupCode: 'test', origin });
  const host = { Host: new URL(origin).host };
  const input = { ...owner, setupCode: 'test' };
  assert.equal((await http('/api/auth/bootstrap', 'POST', input, null, { ...host, Origin: 'http://192.168.4.2:14443' })).status, 403);
  const response = await http('/api/auth/bootstrap', 'POST', input, null, { ...host, Origin: origin });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure/);
  const session = await sessionHeaders(response);
  const current = await http('/api/auth/session', 'GET', undefined, session, host);
  assert.equal((await current.json()).user.username, owner.username);
});

test('NAS requires its HTTPS origin and only built-in administrators can inspect or write credentials', async t => {
  const origin = 'https://voice.example.test:14443';
  const browser = { Host: new URL(origin).host, Origin: origin };
  const secret = 'fake-voice-test-key';
  let keySource = 'none';
  const openai = {
    config: async () => ({ available: keySource === 'file', keySource }),
    saveKey: async value => {
      assert.equal(value, secret);
      keySource = 'file';
      return { available: true, keySource };
    },
    synthesize: async () => Buffer.from('authenticated shared voice result'),
  };
  const dir = await mkdtemp(join(tmpdir(), 'voice-nas-account-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, 'access.sqlite');
  const http = await listen(t, { database, setupCode: 'test', origin, openai, speech: {} });
  const bootstrap = { ...owner, setupCode: 'test' };
  assert.equal((await http('/api/auth/bootstrap', 'POST', bootstrap)).status, 403);
  assert.equal((await http('/api/auth/bootstrap', 'POST', bootstrap, null, { ...browser, Origin: 'http://voice.example.test:14443' })).status, 403);
  const created = await http('/api/auth/bootstrap', 'POST', bootstrap, null, browser);
  assert.match(created.headers.get('set-cookie'), /; Secure$/);
  const admin = await sessionHeaders(created);
  assert.equal((await http('/api/admin/roles', 'POST', { name: 'Delegated key', permissions: ['keys.manage'] }, admin, browser)).status, 403);
  const legacy = new DatabaseSync(database);
  try {
    legacy.exec("INSERT INTO role_permissions(role_id,permission) VALUES ('member','keys.manage')");
  } finally { legacy.close(); }
  assert.equal((await http('/api/admin/users', 'POST', member, admin, browser)).status, 200);
  const login = await http('/api/auth/login', 'POST', member, null, browser);
  const guest = await sessionHeaders(login);
  assert.ok(!(await login.json()).permissions.includes('keys.manage'));
  for (const method of ['GET', 'POST']) {
    assert.equal((await http('/api/openai/key', method, method === 'POST' ? { apiKey: secret } : undefined, guest, browser)).status, 403);
  }
  assert.deepEqual(await (await http('/api/openai/key', 'GET', undefined, admin, browser)).json(), { keySource: 'none' });
  const saved = await http('/api/openai/key', 'POST', { apiKey: secret }, admin, browser);
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes(secret));
  const config = await (await http('/api/config', 'GET', undefined, guest, browser)).json();
  assert.equal(config.cloudOnly, true);
  assert.deepEqual(config.openai, { available: true });
  assert.equal((await http('/api/openai/synthesize', 'POST', { text: '你好' }, guest, browser)).status, 200);
  assert.equal((await http('/api/qwen/synthesize', 'POST', { text: '你好' }, guest, browser)).status, 503);
});
test('shared accounts, first-owner verification and independent origin-bound sessions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-owner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { database: join(dir, 'access.sqlite') };
  const first = await listen(t, options), second = await listen(t, options);
  const status = await (await first('/api/auth/session')).json();
  assert.deepEqual(status, { needsSetup: true, user: null, permissions: [] });
  assert.equal((await first('/api/config')).status, 401);
  assert.equal((await first('/api/auth/bootstrap', 'POST', owner)).status, 403);
  const setupCode = (await readFile(join(dir, 'bootstrap-code'), 'utf8')).trim();
  assert.equal((await stat(join(dir, 'bootstrap-code'))).mode & 0o777, 0o600);
  assert.equal((await first('/api/auth/bootstrap', 'POST', { ...owner, setupCode }, null, { Origin: 'https://example.test' })).status, 403);
  const response = await first('/api/auth/bootstrap', 'POST', { ...owner, setupCode });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const token = await sessionHeaders(response);
  const session = await response.json();
  assert(!('token' in session));
  assert.deepEqual(session.user.roleIds, ['admin']);
  await assert.rejects(readFile(join(dir, 'bootstrap-code')), { code: 'ENOENT' });
  assert.equal((await second('/api/auth/bootstrap', 'POST', { ...owner, setupCode })).status, 409);
  assert.equal((await first('/api/admin/users', 'GET', undefined, { Cookie: token.Cookie })).status, 401);
  assert.equal((await first('/api/admin/users', 'GET', undefined, { 'X-Voice-Proof': token['X-Voice-Proof'] })).status, 401);
  assert.equal((await second('/api/admin/users', 'GET', undefined, token)).status, 401);
  const other = await sessionHeaders(await second('/api/auth/login', 'POST', owner));
  assert.equal((await (await second('/api/auth/session', 'GET', undefined, other)).json()).user.id, session.user.id);
  assert.equal((await second('/api/auth/logout', 'POST', {}, other)).status, 200);
  assert.equal((await first('/api/admin/users', 'GET', undefined, token)).status, 200);
  assert.equal((await first('/api/auth/logout', 'POST', {}, token)).status, 200);
  assert.equal((await first('/api/admin/users', 'GET', undefined, token)).status, 401);
});

test('custom databases in one directory have independent first-admin codes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-workspaces-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await listen(t, { database: join(dir, 'a.sqlite') });
  const b = await listen(t, { database: join(dir, 'b.sqlite') });
  const firstCode = (await readFile(join(dir, 'a.sqlite.bootstrap-code'), 'utf8')).trim();
  const secondCode = (await readFile(join(dir, 'b.sqlite.bootstrap-code'), 'utf8')).trim();
  assert.notEqual(firstCode, secondCode);
  assert.equal((await a('/api/auth/bootstrap', 'POST', { ...owner, setupCode: firstCode })).status, 200);
  assert.equal((await b('/api/auth/bootstrap', 'POST', { ...owner, setupCode: firstCode })).status, 403);
  assert.equal((await b('/api/auth/bootstrap', 'POST', { ...owner, setupCode: secondCode })).status, 200);
});

test('effective role changes are enforced before each conversion, secret change and device authorization', async t => {
  const calls = [];
  const speech = {config: async () => ({ qwen: { available: true }, transcription: { available: true } }),
    synthesize: async () => { calls.push('local'); return Buffer.from('fixture-audio'); }};
  const openai = { config: async () => ({ available: true, keySource: 'file' }),
    saveKey: () => assert.fail('must authorize before key writes'),
    synthesize: () => assert.fail('must authorize before cloud requests'),
    enrollment: () => assert.fail('must authorize before uploads') };
  const http = await listen(t, { database: ':memory:', setupCode: 'fixture', speech, openai });
  const bootstrap = await http('/api/auth/bootstrap', 'POST', { ...owner, setupCode: 'fixture' });
  const admin = await sessionHeaders(bootstrap), ownerId = (await bootstrap.json()).user.id;
  const created = await http('/api/admin/roles', 'POST', { name: '本地朗读员', permissions: ['tts.local'] }, admin);
  assert.equal(created.status, 200);
  const { role } = await created.json();
  const { user } = await (await http('/api/admin/users', 'POST', { ...member, roleIds: [role.id] }, admin)).json();
  const userCookie = await sessionHeaders(await http('/api/auth/login', 'POST', member));
  const switched = await http('/api/qwen/synthesize', 'POST', {}, userCookie, { 'X-Voice-Actor': ownerId });
  assert.equal(switched.status, 409);
  assert.equal(switched.headers.get('x-voice-account-changed'), '1');
  for (const path of ['/api/openai/synthesize','/api/openai/transcribe','/api/transcribe','/api/openai/key',
    '/api/openai/voices','/api/openai/voice-consents','/api/auth/desktop-authorize','/api/admin/roles','/api/admin/users']) {
    assert.equal((await http(path, 'POST', {}, userCookie)).status, 403, path);
  }
  assert.equal((await http('/api/admin/audit', 'GET', undefined, userCookie)).status, 403);
  assert.equal((await http('/api/qwen/synthesize', 'POST', { text: 'private-audio-text' }, userCookie)).status, 200);
  assert.deepEqual(calls, ['local']);
  assert.equal((await http('/api/admin/roles/'+role.id,'PATCH',{ permissions: [] },admin)).status,200);
  assert.equal((await http('/api/qwen/synthesize','POST',{},userCookie)).status,403);
  assert.deepEqual(calls,['local']);
  assert.equal((await http('/api/admin/users/'+user.id,'PATCH',{ active: false },admin)).status,200);
  assert.equal((await http('/api/config','GET',undefined,userCookie)).status,401);
  assert.equal((await http('/api/admin/users/'+ownerId,'DELETE',undefined,admin)).status,409);
  assert.equal((await http('/api/admin/users/'+ownerId,'PATCH',{roleIds:[]},admin)).status,409);
  const { entries } = await (await http('/api/admin/audit','GET',undefined,admin)).json();
  assert(entries.some(e=>e.actor==='speaker' && e.action==='tts.local.request'));
  assert(!JSON.stringify(entries).includes('private-audio-text'));
  assert(!JSON.stringify(entries).includes(member.password));
});
