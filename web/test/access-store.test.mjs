import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAccessStore, PERMISSIONS, SESSION_TTL_SECONDS } from '../backend/access.mjs';

const password = 'fixture-admin-only';
const memberPassword = 'fixture-member-only';

function memory(t, options = {}) {
  const store = createAccessStore({ filename: ':memory:', ...options });
  t.after(() => store.close());
  return store;
}
const admin = store => store.bootstrap({ username: 'Owner', password });
const login = (store, username, value, clientKey = username) => store.login({ username, password: value }, clientKey);
const denied = (operation, status) => assert.rejects(async () => operation(), { status });

test('首次注册的竞争只有一名管理员获胜，文件仅限本人访问，重启后会话仍有效', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-access-store-'));
  const filename = join(dir, 'config', 'access.sqlite');
  const one = createAccessStore({ filename }), two = createAccessStore({ filename });
  t.after(async () => { one.close(); two.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(one.status(), { needsSetup: true, user: null, permissions: [] });
  const results = await Promise.allSettled([admin(one), admin(two)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  const owner = results.find(r => r.status === 'fulfilled').value;
  assert.deepEqual(owner.user.roleIds, ['admin']);
  assert.deepEqual(one.status(owner.token), two.status(owner.token));
  assert.deepEqual([...owner.permissions].sort(), [...PERMISSIONS].sort());
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const reopened = createAccessStore({ filename });
  try {
    assert.deepEqual(reopened.status(owner.token), { needsSetup: false, user: owner.user, permissions: owner.permissions });
    const raw = new DatabaseSync(filename, { readOnly: true });
    try {
      const row = raw.prepare('SELECT salt,pass_hash FROM users').get();
      assert.equal(row.salt.length, 16);
      assert.equal(row.pass_hash.length, 32);
      const session = raw.prepare('SELECT token_hash FROM sessions').get().token_hash;
      assert.notEqual(session, owner.token);
      assert.match(session, /^[a-f0-9]{64}$/);
    } finally { raw.close(); }
  } finally { reopened.close(); }
});

test('用户名去空格并大小写查重，权限取多角色并集，删除角色立即更新既有会话', async t => {
  const store = memory(t);
  const root = await admin(store);
  const speaker = store.createRole(root.token, { name: '本机朗读', permissions: ['tts.local'] });
  const reader = store.createRole(root.token, { name: '云端转写', permissions: ['stt.openai'] });
  const user = await store.createUser(root.token, { username: ' Alice ', password: memberPassword, roleIds: [speaker.id, reader.id] });
  assert.equal(user.username, 'Alice');
  await denied(() => store.createUser(root.token, { username: 'ALICE', password: memberPassword, roleIds: [] }), 409);
  const session = await login(store, 'alice', memberPassword);
  assert.deepEqual(session.permissions, ['stt.openai', 'tts.local']);
  assert.deepEqual(store.ownRoles(session.token).map(role => role.name).sort(), ['云端转写', '本机朗读'].sort());
  assert.equal(store.beginOperation(session.token, 'tts.local').user.id, user.id);
  await denied(() => store.beginOperation(session.token, 'tts.openai'), 403);
  const changed = store.updateRole(root.token, reader.id, { permissions: ['stt.local'] });
  assert.deepEqual(changed.permissions, ['stt.local']);
  assert.deepEqual(store.status(session.token).permissions, ['stt.local', 'tts.local']);
  store.deleteRole(root.token, speaker.id);
  assert.deepEqual(store.status(session.token).user.roleIds, [reader.id]);
  assert.deepEqual(store.status(session.token).permissions, ['stt.local']);
  await denied(() => store.listUsers(session.token), 403);
  await denied(() => store.listAudit(session.token), 403);
  await denied(() => store.createRole(root.token, { name: '错误', permissions: ['unknown.op'] }), 400);
});

test('委派用户或角色管理者只能操作权限子集，不能修改管理员和更高权限用户', async t => {
  const store = memory(t), root = await admin(store);
  const weak = store.createRole(root.token, { name: '仅朗读', permissions: ['tts.local'] });
  const manager = store.createRole(root.token, { name: '人员管理', permissions: ['users.manage', 'tts.local'] });
  const editor = store.createRole(root.token, { name: '角色管理', permissions: ['roles.manage', 'tts.local'] });
  const support = await store.createUser(root.token, { username: 'Support', password: memberPassword, roleIds: [manager.id] });
  await store.createUser(root.token, { username: 'Editor', password: memberPassword, roleIds: [editor.id] });
  const usersToken = (await login(store, 'support', memberPassword)).token;
  const rolesToken = (await login(store, 'Editor', memberPassword)).token;
  const customer = await store.createUser(usersToken, { username: 'Customer', password: memberPassword, roleIds: [weak.id] });
  assert.ok(store.listUsers(usersToken).some(u => u.id === customer.id));
  assert.ok(!store.listUsers(usersToken).some(u => u.id === root.user.id));
  assert.ok(!store.listRoles(usersToken).some(r => r.id === 'admin'));
  await denied(() => store.createRole(usersToken, { name: '另一个管理员', permissions: PERMISSIONS }), 403);
  await denied(() => store.updateUser(usersToken, support.id, { roleIds: ['admin'] }), 403);
  await denied(() => store.updateUser(usersToken, root.user.id, { password: 'try-reset-secret' }), 403);
  await denied(() => store.updateUser(usersToken, customer.id, { roleIds: ['member'] }), 403);
  await denied(() => store.deleteUser(usersToken, root.user.id), 403);
  await denied(() => store.listUsers(rolesToken), 403);
  await denied(() => store.createRole(rolesToken, { name: '越权', permissions: ['users.manage'] }), 403);
  await denied(() => store.updateRole(rolesToken, editor.id, { permissions: PERMISSIONS }), 403);
  await denied(() => store.deleteRole(rolesToken, manager.id), 403);
  await store.updateUser(root.token, root.user.id, { roleIds: ['admin', weak.id] });
  await denied(() => store.deleteRole(rolesToken, weak.id), 403);
  store.updateRole(rolesToken, editor.id, { name: '角色管理员' });
  const all = store.createRole(root.token, { name: '所有委派权限', permissions: PERMISSIONS.filter(permission => permission !== 'keys.manage') });
  await store.updateUser(root.token, support.id, { roleIds: [all.id] });
  await denied(() => store.updateUser(usersToken, support.id, { roleIds: ['admin'] }), 403);
  await denied(() => store.updateUser(usersToken, root.user.id, { active: false }), 403);
});

test('密码派生期间权限被撤回时，再校验阻止未授权写入', async t => {
  const store = memory(t), root = await admin(store);
  const role = store.createRole(root.token, { name: '编辑人员', permissions: ['users.manage'] });
  const staff = await store.createUser(root.token, { username: 'staff', password: memberPassword, roleIds: [role.id] });
  const session = await login(store, staff.username, memberPassword);
  const write = store.createUser(session.token, { username: 'pending', password: memberPassword, roleIds: [] });
  store.updateRole(root.token, role.id, { permissions: [] });
  await denied(() => write, 403);
  assert.ok(!store.listUsers(root.token).some(row => row.username === 'pending'));
});

test('多层及多重继承汇总权限；父角色修改、解除继承与删除实时生效', async t => {
  const store = memory(t), root = await admin(store);
  const main = store.createRole(root.token, { name: '基准', permissions: ['tts.local'] });
  const first = store.createRole(root.token, { name: '转写分组', parentIds: [main.id], permissions: ['stt.local'] });
  const second = store.createRole(root.token, { name: '朗读分组', parentIds: [main.id] });
  const role = store.createRole(root.token, {
    name: '复核', parentIds: [first.id, second.id, first.id, 'auditor'], permissions: ['tts.local'],
  });
  assert.deepEqual(role.parentIds, [first.id, second.id, 'auditor'].sort());
  assert.deepEqual(role.permissions, ['tts.local']);
  assert.deepEqual(role.effectivePermissions, ['audit.read', 'stt.local', 'tts.local']);
  const actor = await store.createUser(root.token, { username: '复核员', password: memberPassword, roleIds: [role.id] });
  const session = await login(store, actor.username, memberPassword);
  assert.deepEqual(store.status(session.token).permissions, role.effectivePermissions);
  assert.deepEqual(store.ownRoles(session.token), [role]);
  store.updateRole(root.token, main.id, { permissions: ['tts.openai'] });
  assert.ok(store.requirePermissions(session.token, 'tts.openai'));
  const renamed = store.updateRole(root.token, role.id, { name: '新名称' });
  assert.deepEqual(renamed.parentIds, role.parentIds);
  await denied(() => store.updateRole(root.token, main.id, { name: '不该保留', parentIds: [role.id] }), 409);
  await denied(() => store.updateRole(root.token, main.id, { parentIds: [main.id] }), 409);
  await denied(() => store.createRole(root.token, { name: '继承管理员', parentIds: ['admin'] }), 403);
  await denied(() => store.updateRole(root.token, role.id, { parentIds: ['不存在'] }), 400);
  await denied(() => store.updateRole(root.token, 'member', { parentIds: [main.id] }), 403);
  await denied(() => store.deleteRole(root.token, main.id), 409);
  assert.equal(store.listRoles(root.token).find(r => r.id === main.id).name, '基准');
  store.updateRole(root.token, first.id, { parentIds: [] });
  assert.ok(store.requirePermissions(session.token, 'tts.openai'));
  store.updateRole(root.token, second.id, { parentIds: [] });
  await denied(() => store.requirePermissions(session.token, 'tts.openai'), 403);
  store.deleteRole(root.token, main.id);
  store.deleteRole(root.token, role.id);
  assert.deepEqual(store.status(session.token).permissions, []);
  assert.deepEqual(store.status(session.token).user.roleIds, []);
});

test('委派权限上限覆盖所有祖先、下级角色和继承该角色的高权限用户', async t => {
  const store = memory(t), root = await admin(store);
  const delegated = store.createRole(root.token, { name: '委派', permissions: ['roles.manage', 'users.manage'] });
  const lower = store.createRole(root.token, { name: '基础朗读', permissions: ['tts.local'] });
  const staffRole = store.createRole(root.token, { name: '主管', parentIds: [delegated.id, lower.id] });
  const staff = await store.createUser(root.token, { username: 'staff', password: memberPassword, roleIds: [staffRole.id] });
  const { token } = await login(store, staff.username, memberPassword);
  const linked = store.createRole(token, { name: '朗读员', parentIds: [lower.id] });
  const high = store.createRole(root.token, { name: '审计负责人', parentIds: [linked.id, 'auditor'] });
  const indirect = store.createRole(root.token, { name: '查看审计', parentIds: [high.id] });
  assert.ok(!store.listRoles(token).some(role => role.id === indirect.id));
  await denied(() => store.createRole(token, { name: '超额角色', parentIds: [indirect.id] }), 403);
  await denied(() => store.updateRole(token, staffRole.id, { parentIds: [high.id] }), 403);
  await denied(() => store.updateUser(token, staff.id, { roleIds: [indirect.id] }), 403);
  await denied(() => store.updateRole(token, lower.id, { permissions: [] }), 403);
  await denied(() => store.deleteRole(token, linked.id), 403);
  store.updateRole(root.token, high.id, { parentIds: ['auditor'] });
  const higher = await store.createUser(root.token, { username: 'higher', password: memberPassword, roleIds: [linked.id, 'auditor'] });
  await denied(() => store.updateRole(token, lower.id, { permissions: [] }), 403);
  await denied(() => store.updateUser(token, higher.id, { active: false }), 403);
  await store.updateUser(root.token, higher.id, { roleIds: ['auditor'] });
  store.updateRole(token, lower.id, { permissions: [] });
  assert.ok(!store.status(token).permissions.includes('tts.local'));
});

test('保护最后一位启用管理员，系统角色不可更名、改权限或删除', async t => {
  const store = memory(t), root = await admin(store);
  for (const role of ['admin', 'member', 'auditor']) {
    await denied(() => store.updateRole(root.token, role, { name: '重命名' }), 403);
    await denied(() => store.updateRole(root.token, role, { permissions: [] }), 403);
    await denied(() => store.deleteRole(root.token, role), 403);
  }
  await denied(() => store.updateUser(root.token, root.user.id, { active: false }), 409);
  await denied(() => store.updateUser(root.token, root.user.id, { roleIds: ['member'] }), 409);
  await denied(() => store.deleteUser(root.token, root.user.id), 409);
  const other = await store.createUser(root.token, { username: 'second', password: memberPassword, roleIds: ['admin'] });
  const session = await login(store, other.username, memberPassword);
  await store.updateUser(session.token, root.user.id, { active: false });
  assert.equal(store.status(root.token).user, null);
  await denied(() => store.deleteUser(session.token, other.id), 409);
});

test('停用、重置、修改密码撤销所有登录会话，退出仅撤销当前会话', async t => {
  const store = memory(t), root = await admin(store);
  const user = await store.createUser(root.token, { username: 'member', password: memberPassword });
  const first = await login(store, user.username, memberPassword);
  const second = await login(store, user.username, memberPassword);
  store.logout(first.token);
  assert.equal(store.status(first.token).user, null);
  assert.ok(store.status(second.token).user);
  const third = await login(store, user.username, memberPassword);
  await denied(() => store.changePassword(second.token, { currentPassword: 'not-old', newPassword: 'fixture-changed' }), 403);
  await store.changePassword(second.token, { currentPassword: memberPassword, newPassword: 'fixture-changed' });
  assert.equal(store.status(second.token).user, null);
  assert.equal(store.status(third.token).user, null);
  await denied(() => login(store, user.username, memberPassword), 401);
  const afterChange = await login(store, user.username, 'fixture-changed');
  await store.updateUser(root.token, user.id, { password: 'reset-for-fixture' });
  assert.equal(store.status(afterChange.token).user, null);
  const afterReset = await login(store, user.username, 'reset-for-fixture');
  await store.updateUser(root.token, user.id, { active: false });
  await denied(() => login(store, user.username, 'reset-for-fixture'), 401);
  await store.updateUser(root.token, user.id, { active: true });
  assert.equal(store.status(afterReset.token).user, null);
  const reopened = await login(store, user.username, 'reset-for-fixture');
  store.deleteUser(root.token, user.id);
  assert.equal(store.status(reopened.token).user, null);
});

test('固定到期、持久化失败限速和独立客户端计数，不接受篡改令牌', async t => {
  let time = 1_800_000_000_000;
  const store = memory(t, { now: () => time }), root = await admin(store);
  await store.createUser(root.token, { username: 'colleague', password: memberPassword });
  assert.equal(store.status(root.token + 'x').user, null);
  const failures = Array.from({ length: 8 }, () => login(store, 'Owner', 'wrong-pass', 'client-a'));
  const outcomes = await Promise.allSettled(failures);
  assert.deepEqual(outcomes.map(r => r.reason.status).sort(), [401, 401, 401, 401, 401, 429, 429, 429]);
  await denied(() => login(store, 'owner', password, 'client-a'), 429);
  assert.ok((await login(store, 'colleague', memberPassword, 'client-a')).token);
  assert.ok((await login(store, 'owner', password, 'client-b')).token);
  for (let i = 0; i < 60; i++) await denied(() => login(store, 'invalid-' + i, null, 'other-source'), 401);
  await denied(() => login(store, 'colleague', memberPassword, 'other-source'), 429);
  time += 10 * 60 * 1000;
  assert.ok((await login(store, 'owner', password, 'client-a')).token);
  time += SESSION_TTL_SECONDS * 1000 - 10 * 60 * 1000 - 1;
  assert.ok(store.status(root.token).user);
  time++;
  assert.equal(store.status(root.token).user, null);
});

test('审计只读、公示时间排序，保留已删除操作的说明且不含密码或令牌', async t => {
  const store = memory(t), root = await admin(store);
  const role = store.createRole(root.token, { name: '删除测试', permissions: ['stt.local'] });
  store.deleteRole(root.token, role.id);
  const observer = await store.createUser(root.token, { username: 'Observer', password: memberPassword, roleIds: ['auditor'] });
  const reader = await login(store, observer.username, memberPassword);
  store.beginOperation(root.token, 'keys.manage');
  await denied(() => store.beginOperation(reader.token, 'keys.manage'), 403);
  const entries = store.listAudit(reader.token);
  assert.ok(entries.some(e => e.action === 'role.deleted' && e.target === '删除测试'));
  assert.equal(entries[0].action, 'keys.manage.request');
  assert.equal(entries[0].actorId, root.user.id);
  assert.deepEqual(entries[0].details, {});
  assert.deepEqual(entries.map(e => e.id), entries.map(e => e.id).sort((a, b) => b-a));
  assert.ok(entries.every(e => !Number.isNaN(Date.parse(e.at))));
  const json = JSON.stringify(entries);
  for (const secret of [password, memberPassword, root.token, reader.token]) assert.ok(!json.includes(secret));
});
