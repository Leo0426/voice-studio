import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceServer } from '../server.mjs';
import { sessionHeaders, testServer } from './session-fixture.mjs';

function request(origin, path, headers, method = 'GET', body, type) {
  return fetch(origin + path, { method, body, headers: { Origin: origin, ...headers, ...(type && { 'Content-Type': type }) } });
}
const postJSON = (origin, path, headers, object) =>
  request(origin, path, headers, 'POST', JSON.stringify(object), 'application/json');

function wave() {
  const wav = Buffer.alloc(48);
  wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  return wav;
}

test('all four conversion routes persist original results across logins and service instances, scoped to their owner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const transcript = '第一行\n第二行。';
  const speech = {
    synthesize: async () => { calls++; return wave(); },
    transcribe: async () => { calls++; return { text: transcript }; },
  };
  const compressed = Buffer.from([255, 251, 32, 0, 15]);
  const openai = { ...speech, synthesize: async () => { calls++; return compressed; } };
  const options = { database: join(dir, 'access.sqlite'), speech, openai };
  const { origin, headers: admin } = await testServer(t, options);
  const member = { username: 'reader', password: 'isolated-reader-password' };
  const { user } = await (await postJSON(origin, '/api/admin/users', admin, member)).json();
  const login = async base => sessionHeaders(await postJSON(base, '/api/auth/login', {}, member));
  const actor = await login(origin);
  const form = new FormData();
  form.set('file', new Blob(['sample'], { type: 'audio/wav' }), '云端录音.wav');
  const responses = [
    await postJSON(origin, '/api/qwen/synthesize', actor, { text: '本机\n合成' }),
    await request(origin, '/api/transcribe?filename=meeting.wav', actor, 'POST', wave(), 'audio/wav'),
    await postJSON(origin, '/api/openai/synthesize', actor, { text: '云端', format: 'mp3' }),
    await request(origin, '/api/openai/transcribe', actor, 'POST', form),
  ];
  const ids = responses.map(response => { assert.equal(response.status, 200); return response.headers.get('x-voice-task-id'); });
  assert.equal(new Set(ids).size, 4);
  assert.equal((await request(origin, '/api/auth/logout', actor, 'POST')).status, 200);
  assert.equal((await request(origin, '/api/history', actor)).status, 401);
  const service = createWorkspaceServer(options);
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(() => new Promise(resolve => service.close(resolve)));
  const second = 'http://127.0.0.1:' + service.address().port;
  const owner = await login(second);
  const { tasks } = await (await request(second, '/api/history', owner)).json();
  assert.deepEqual(tasks.map(t => t.id), ids.toReversed());
  assert.deepEqual(tasks.map(t => t.format), ['txt','mp3','txt','wav']);
  assert.deepEqual(tasks.map(t => t.label), ['云端录音.wav','云端','meeting.wav','本机 合成']);
  const tts = await (await request(second, '/api/history?kind=tts', owner)).json();
  const stt = await (await request(second, '/api/history?kind=stt', owner)).json();
  assert.deepEqual(tts.tasks.map(t => t.id), [ids[2], ids[0]]);
  assert.deepEqual(stt.tasks.map(t => t.id), [ids[3], ids[1]]);
  assert.equal((await request(second, '/api/history?kind=unknown', owner)).status, 400);
  assert(!tasks.some(t => 'data' in t));
  assert.deepEqual((await (await request(origin, '/api/history', admin)).json()).tasks, []);
  assert.equal((await request(origin, '/api/history/' + ids[0] + '/download', admin)).status, 404);
  assert.equal((await request(origin, '/api/history/' + ids[0], admin, 'DELETE')).status, 404);
  assert.equal((await request(second, '/api/history', { ...owner, 'X-Voice-Actor': 'other-user' })).status, 409);
  await request(origin, '/api/admin/users/' + user.id, admin, 'PATCH', JSON.stringify({ roleIds: [] }), 'application/json');
  for (const [i, expected] of [wave(), Buffer.from(transcript), compressed, Buffer.from(transcript)].entries()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = await request(second, '/api/history/' + ids[i] + '/download', owner);
      assert.equal(file.status, 200);
      assert.match(file.headers.get('content-disposition'), /attachment/);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), expected);
    }
  }
  assert.equal(calls, 4);
  assert.equal((await request(second, '/api/history/' + ids[0], owner, 'DELETE')).status, 200);
  assert.equal((await request(second, '/api/history/' + ids[0] + '/download', owner)).status, 404);
  await request(origin, '/api/admin/users/' + user.id, admin, 'DELETE');
  assert.equal((await request(second, '/api/history/' + ids[1] + '/download', owner)).status, 401);
  await postJSON(origin, '/api/admin/users', admin, member);
  assert.deepEqual((await (await request(second, '/api/history', await login(second))).json()).tasks, []);
});

test('failed and cancelled conversions create terminal history entries without download links', async t => {
  const started = Promise.withResolvers();
  const speech = { synthesize: async ({ text }, signal) => {
    if (text === 'failed') throw Object.assign(new Error('本机合成失败'), { status: 422 });
    started.resolve();
    await once(signal, 'abort');
    throw signal.reason;
  } };
  const { origin, headers } = await testServer(t, { speech });
  assert.equal((await postJSON(origin, '/api/qwen/synthesize', headers, { text: 'failed' })).status, 422);
  const controller = new AbortController();
  const pending = fetch(origin + '/api/qwen/synthesize', {
    method:'POST', headers:{...headers, Origin:origin, 'Content-Type':'application/json'},
    body:JSON.stringify({ text:'cancelled' }), signal:controller.signal,
  });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name:'AbortError' });
  let tasks;
  for (let i = 0; i < 100; i++) {
    ({ tasks } = await (await request(origin, '/api/history', headers)).json());
    if (tasks.length === 2) break;
    await delay(10);
  }
  assert.deepEqual(tasks.map(t => t.status), ['cancelled', 'failed']);
  for (const task of tasks) {
    assert.equal(task.bytes, 0);
    assert.equal((await request(origin, '/api/history/' + task.id + '/download', headers)).status, 409);
  }
});

test('native submissions bind to the original signed-in device operator and keep idempotent audio', async t => {
  const site = await testServer(t);
  const device = await testServer(t, { desktop: true });
  const id = randomUUID();
  const nativePath = '/api/history/native/' + id;
  async function upload(client, actorHeaders, body = wave(), path = nativePath) {
    return request(client.origin, path, actorHeaders, 'POST', body, 'audio/wav');
  }
  const identity = async client => (await (await request(client.origin, '/api/auth/session', client.headers)).json()).user.id;
  assert.equal((await upload(site, { ...site.headers, 'X-Voice-Actor': await identity(site) })).status, 404);
  assert.equal((await upload(device, device.headers)).status, 403);
  const headers = { ...device.headers, 'X-Voice-Actor': await identity(device), 'X-Voice-Label': encodeURIComponent('设备 · 旁白') };
  assert.equal((await upload(device, headers, Buffer.from('bad audio'))).status, 422);
  assert.equal((await upload(device, { ...headers, 'X-Voice-Actor': randomUUID() })).status, 409);
  const member = { username: 'another', password: 'isolated-another-password' };
  const { user } = await (await postJSON(device.origin, '/api/admin/users', device.headers, member)).json();
  const ordinary = await sessionHeaders(await postJSON(device.origin, '/api/auth/login', {}, member));
  assert.equal((await upload(device, { ...ordinary, 'X-Voice-Actor': user.id })).status, 403);
  for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await (await upload(device, headers)).json(), { id });
  const modified = wave(); modified[44]++;
  assert.equal((await upload(device, headers, modified)).status, 409);
  const incomplete = randomUUID();
  assert.equal((await upload(device, { ...headers, 'X-Voice-Status':'cancelled' }, Buffer.alloc(0), '/api/history/native/' + incomplete)).status, 200);
  const { tasks } = await (await request(device.origin, '/api/history', device.headers)).json();
  assert.deepEqual(tasks.map(t => t.id), [incomplete, id]);
  assert.equal(tasks[1].label, '设备 · 旁白');
  const downloaded = await request(device.origin, '/api/history/' + id + '/download', device.headers);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), wave());
  assert.equal((await request(device.origin, '/api/history/' + id, device.headers, 'DELETE')).status, 200);
  assert.equal((await upload(device, headers)).status, 409);
});
