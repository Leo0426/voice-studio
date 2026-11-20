import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAccessStore } from '../backend/access.mjs';

const password = 'local-fixture-password';
const transcription = { kind: 'stt', engine: 'whisper', format: 'txt', status: 'completed', label: '听写',
  data: Buffer.from('你好，世界。\n') };
const reading = { kind: 'tts', engine: 'openai', format: 'mp3', status: 'completed', label: '朗读',
  data: Buffer.from([0, 127, 128, 255]) };

function memory(t, options = {}) {
  const store = createAccessStore({ filename: ':memory:', ...options });
  t.after(() => store.close());
  return store;
}

const admin = store => store.bootstrap({ username: 'owner', password });

async function addMember(store, owner, username) {
  await store.createUser(owner.token, { username, password });
  return store.login({ username, password }, username);
}

test('任务属于稳定的账号 ID；撤回转换权限仍能下载既有结果，同名重建不继承记录', async t => {
  const store = memory(t), owner = await admin(store);
  const member = await addMember(store, owner, 'member');
  const id = store.recordTask(member.user.id, transcription);
  assert.deepEqual(store.listTasks(owner.token), { tasks: [], nextCursor: null });
  assert.throws(() => store.downloadTask(owner.token, id), { status: 404 });
  assert.throws(() => store.deleteTask(owner.token, id), { status: 404 });
  assert.throws(() => store.downloadTask('', id), { status: 401 });
  assert.throws(() => store.listTasks(''), { status: 401 });
  await store.updateUser(owner.token, member.user.id, { roleIds: [] });
  const result = store.downloadTask(member.token, id);
  assert.deepEqual(result, { id, format: 'txt', data: transcription.data });
  result.data[0] = 0;
  assert.deepEqual(store.downloadTask(member.token, id).data, transcription.data);
  await store.updateUser(owner.token, member.user.id, { active: false });
  assert.throws(() => store.downloadTask(member.token, id), { status: 401 });
  store.deleteUser(owner.token, member.user.id);
  const replacement = await addMember(store, owner, 'member');
  assert.notEqual(replacement.user.id, member.user.id);
  assert.throws(() => store.recordTask(member.user.id, reading), { status: 404 });
  assert.throws(() => store.downloadTask(replacement.token, id), { status: 404 });
  assert.deepEqual(store.listTasks(replacement.token), { tasks: [], nextCursor: null });
});

test('同一 UUID 的重试对照归属、元数据和每个结果字节，保留首次完成时间', async t => {
  let time = Date.UTC(2026, 10, 20);
  const store = memory(t, { now: () => time }), owner = await admin(store);
  const member = await addMember(store, owner, 'member');
  for (const status of ['completed', 'failed', 'cancelled']) {
    const id = randomUUID();
    const data = status === 'completed' ? reading.data : undefined;
    const task = { ...reading, id, data, status };
    assert.equal(store.recordTask(member.user.id, task), id);
    time += 1000;
    assert.equal(store.recordTask(member.user.id, { ...task, id: id.toUpperCase() }), id);
    const saved = store.listTasks(member.token).tasks.find(row => row.id === id);
    assert.deepEqual(saved, { id, kind: 'tts', engine: 'openai', format: 'mp3', label: '朗读', status,
      bytes: data?.length ?? 0, createdAt: new Date(time - 1000).toISOString() });
    assert.throws(() => store.recordTask(owner.user.id, task), { status: 409 });
    assert.throws(() => store.recordTask(member.user.id, { ...task, label: '另一项' }), { status: 409 });
    if (status === 'completed') {
      assert.throws(() => store.recordTask(member.user.id, { ...task, data: Buffer.from([0, 127, 128, 254]) }), { status: 409 });
      assert.deepEqual(store.downloadTask(member.token, id.toUpperCase()).data, data);
    } else {
      assert.throws(() => store.downloadTask(member.token, id), { status: 409 });
    }
  }
  for (const changes of [{ data: null }, { data: Buffer.alloc(0) }, { status: 'failed' }, { status: 'queued' },
    { id: 'not-a-uuid' }, { label: '' }, { kind: 'stt' }, { engine: 'whisper' }, { format: 'png' }]) {
    assert.throws(() => store.recordTask(member.user.id, { ...reading, ...changes }), { status: 400 });
  }
  assert.equal(store.listTasks(member.token).tasks.length, 3);
});

test('同一时间完成的 207 个任务分页无遗漏，新任务与其他用户的游标均不干扰后续页', async t => {
  const store = memory(t, { now: () => Date.UTC(2026, 10, 20) }), owner = await admin(store);
  const other = await addMember(store, owner, 'other');
  const ids = Array.from({ length: 207 }, () => store.recordTask(owner.user.id, transcription)).reverse();
  const privateId = store.recordTask(other.user.id, reading);
  const first = store.listTasks(owner.token);
  assert.equal(first.tasks.length, 50);
  assert.equal(typeof first.nextCursor, 'string');
  assert.deepEqual(first.tasks.map(row => row.id), ids.slice(0, 50));
  assert.throws(() => store.listTasks(other.token, { cursor: first.nextCursor }), { status: 400 });
  const altered = (first.nextCursor[0] === 'a' ? 'b' : 'a') + first.nextCursor.slice(1);
  for (const cursor of ['', altered, privateId, randomUUID(), ['bad'], '..']) {
    assert.throws(() => store.listTasks(owner.token, { cursor }), { status: 400 });
  }
  const deleted = ids[49];
  assert.deepEqual(store.deleteTask(owner.token, deleted), { id: deleted });
  assert.throws(() => store.recordTask(owner.user.id, { ...transcription, id: deleted }), { status: 409 });
  assert.throws(() => store.downloadTask(owner.token, deleted), { status: 404 });
  assert.throws(() => store.deleteTask(owner.token, deleted), { status: 404 });
  store.recordTask(owner.user.id, reading);
  const seen = first.tasks.map(row => row.id);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = store.listTasks(owner.token, { cursor });
    seen.push(...page.tasks.map(row => row.id));
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, ids);
});

test('按模块独立分页，倒序保留同一时间内的任务顺序', async t => {
  const store = memory(t, { now: () => Date.UTC(2026, 10, 20) });
  const owner = await admin(store);
  const ids = { tts: [], stt: [] };
  for (let i = 0; i < 7; i++) {
    ids.tts.unshift(store.recordTask(owner.user.id, reading));
    ids.stt.unshift(store.recordTask(owner.user.id, transcription));
  }
  for (const kind of ['tts', 'stt']) {
    const page = store.listTasks(owner.token, { kind });
    assert.deepEqual(page.tasks.map(task => task.id), ids[kind].slice(0, 5));
    const last = store.listTasks(owner.token, { kind, cursor: page.nextCursor });
    assert.deepEqual(last.tasks.map(task => task.id), ids[kind].slice(5));
    assert.equal(last.nextCursor, null);
    const other = kind === 'tts' ? 'stt' : 'tts';
    assert.throws(() => store.listTasks(owner.token, { kind: other, cursor: page.nextCursor }), { status: 400 });
  }
});

test('重启后结果可重下；结果写入失败时元数据回滚；删除账号时同步清除二进制结果', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-task-store-')), filename = join(dir, 'account.sqlite');
  const store = createAccessStore({ filename }), owner = await admin(store);
  const member = await addMember(store, owner, 'member'), id = store.recordTask(member.user.id, reading);
  for (let i = 0; i < 50; i++) store.recordTask(member.user.id, transcription);
  const { tasks, nextCursor } = store.listTasks(member.token);
  store.deleteTask(member.token, tasks.at(-1).id);
  store.close();
  const reopened = createAccessStore({ filename }), raw = new DatabaseSync(filename);
  t.after(async () => { raw.close(); reopened.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(reopened.downloadTask(member.token, id), { id, format: 'mp3', data: reading.data });
  assert.deepEqual(reopened.listTasks(member.token, { cursor: nextCursor }).tasks.map(row => row.id), [id]);
  raw.exec("CREATE TRIGGER unavailable_result BEFORE INSERT ON personal_task_results BEGIN SELECT RAISE(ABORT,'fixture-write-error'); END");
  assert.throws(() => reopened.recordTask(member.user.id, reading), /fixture-write-error/);
  assert.equal(reopened.listTasks(member.token).tasks.length, 50);
  reopened.deleteUser(owner.token, member.user.id);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM personal_tasks').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM personal_task_results').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM deleted_personal_task_ids').get().n, 0);
});
