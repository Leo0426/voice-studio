import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { accountDatabase } from './setup-code.mjs';
import { createPersonalTasks } from './personal-tasks.mjs';

export const PERMISSIONS = Object.freeze([
  'tts.local', 'stt.local', 'tts.openai', 'stt.openai', 'voices.manage', 'keys.manage',
  'users.manage', 'roles.manage', 'audit.read', 'desktop.manage',
]);
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const builtins = [
  ['admin', '管理员', PERMISSIONS],
  ['member', '成员', ['tts.local', 'stt.local', 'tts.openai', 'stt.openai']],
  ['auditor', '审计员', ['audit.read']],
];
const derive = promisify(scrypt);
const throttleWindow = 10 * 60 * 1000;
const maxFailures = 5;

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

function label(value, field) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) reject(400, field + '格式无效。');
  const cleaned = value.trim().normalize('NFKC');
  if (!cleaned || [...cleaned].length > 64) reject(400, field + '须为 1 至 64 个字符。');
  return cleaned;
}

function checkPassword(value) {
  if (typeof value !== 'string' || value.length > 256 || [...value].length < 8 || [...value].length > 128) {
    reject(400, '密码长度须为 8 至 128 个字符。');
  }
  return value;
}

function hashPassword(password, salt) {
  return derive(password, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function uniqueStrings(value, field) {
  if (!Array.isArray(value) || value.length > 256 || value.some(id => typeof id !== 'string' || !id || id.length > 128)) {
    reject(400, field + '格式无效。');
  }
  return [...new Set(value)];
}

function checkedPermissions(value) {
  const names = uniqueStrings(value, '权限');
  if (names.some(id => !PERMISSIONS.includes(id))) reject(400, '包含未知权限。');
  return names;
}

export function createAccessStore({ filename = accountDatabase(), now = Date.now } = {}) {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    closeSync(openSync(filename, 'a', 0o600));
    chmodSync(filename, 0o600);
  }
  const db = new DatabaseSync(filename);
  const dummySalt = randomBytes(16);
  const invalidHash = Buffer.alloc(32);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  const statement = sql => db.prepare(sql);
  let inTransaction = false;
  function transaction(work, begin = 'BEGIN IMMEDIATE') {
    db.exec(begin);
    inTransaction = true;
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      inTransaction = false;
    }
  }

  // Keep session, role, and permission reads in the same snapshot across service processes.
  function readSnapshot(work) {
    return inTransaction ? work() : transaction(work, 'BEGIN');
  }
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
        salt BLOB NOT NULL, pass_hash BLOB NOT NULL, active INTEGER NOT NULL CHECK (active IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, builtin INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, permission TEXT NOT NULL,
        PRIMARY KEY(role_id, permission)
      );
      CREATE TABLE IF NOT EXISTS role_parents (
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        parent_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
        PRIMARY KEY(role_id, parent_id), CHECK (role_id<>parent_id AND parent_id<>'admin')
      );
      CREATE INDEX IF NOT EXISTS role_parents_by_parent ON role_parents(parent_id);
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(user_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS user_roles_by_role ON user_roles(role_id);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires);
      CREATE TABLE IF NOT EXISTS login_limits (
        bucket TEXT PRIMARY KEY, started INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_audit (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor_id TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, target_id TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL
      );
    `);
    for (const [id, name, permissions] of builtins) {
      statement('INSERT OR IGNORE INTO roles(id,name,name_key,builtin) VALUES (?,?,?,1)').run(id, name, name.toLowerCase());
      for (const permission of permissions) {
        statement('INSERT OR IGNORE INTO role_permissions(role_id,permission) VALUES (?,?)').run(id, permission);
      }
    }
  });

  function userFor(id) {
    const row = statement('SELECT id, username, active FROM users WHERE id=?').get(id);
    if (!row) return null;
    const roleIds = statement('SELECT role_id FROM user_roles WHERE user_id=? ORDER BY role_id').all(id).map(r => r.role_id);
    return { id: row.id, username: row.username, active: Boolean(row.active), roleIds };
  }

  function roleFor(id) {
    const row = statement('SELECT id, name, builtin FROM roles WHERE id=?').get(id);
    if (!row) return null;
    const permissions = statement(`SELECT permission FROM role_permissions
      WHERE role_id=? AND (permission<>'keys.manage' OR role_id='admin') ORDER BY permission`).all(id).map(r => r.permission);
    const parentIds = statement('SELECT parent_id FROM role_parents WHERE role_id=? ORDER BY parent_id').all(id).map(row => row.parent_id);
    const effectivePermissions = parentIds.length ? inheritedPermissions('SELECT ?', id) : permissions;
    return { id: row.id, name: row.name, builtin: Boolean(row.builtin), permissions, parentIds, effectivePermissions };
  }

  function inheritedPermissions(seedQuery, id) {
    return statement(`WITH RECURSIVE inherited(id) AS (
      ${seedQuery} UNION SELECT p.parent_id FROM role_parents p JOIN inherited i ON i.id=p.role_id
    ) SELECT DISTINCT p.permission FROM inherited i JOIN role_permissions p ON p.role_id=i.id
      WHERE p.permission<>'keys.manage' OR p.role_id='admin'
      ORDER BY p.permission`).all(id).map(row => row.permission);
  }

  function permissionsForUser(id) {
    return inheritedPermissions('SELECT role_id FROM user_roles WHERE user_id=?', id);
  }

  function descendantIds(id) {
    return statement(`WITH RECURSIVE descendants(id) AS (
      SELECT ? UNION SELECT p.role_id FROM role_parents p JOIN descendants d ON d.id=p.parent_id
    ) SELECT id FROM descendants`).all(id).map(row => row.id);
  }

  function needsSetup() { return !statement('SELECT 1 FROM users LIMIT 1').get(); }

  function status(token) {
    return readSnapshot(() => {
      const session = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
        ? statement(`SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires>? AND u.active=1`).get(digest(token), now()) : null;
      const user = session ? userFor(session.user_id) : null;
      return { needsSetup: user ? false : needsSetup(), user, permissions: user ? permissionsForUser(user.id) : [] };
    });
  }

  function requirePermissions(token, ...wanted) {
    const access = status(token);
    if (!access.user) reject(401, '请先登录，或重新登录已过期的会话。');
    if (wanted.includes('keys.manage') && !hasAdminRole(access)) reject(403, '只有管理员可以配置 OpenAI 密钥。');
    if (!wanted.every(id => access.permissions.includes(id))) reject(403, '当前账号缺少执行此操作的权限。');
    return access;
  }

  function hasAdminRole(access) { return access.user.roleIds.includes('admin'); }
  function isSubset(permissions, access) { return permissions.every(id => access.permissions.includes(id)); }
  function canManageUser(user, access) {
    return hasAdminRole(access) || (!user.roleIds.includes('admin') && isSubset(permissionsForUser(user.id), access));
  }
  function canGrant(role, access) {
    return hasAdminRole(access) || (role.id !== 'admin' && isSubset(role.effectivePermissions, access));
  }
  function assignable(roleIds, access) {
    const ids = uniqueStrings(roleIds, '角色');
    for (const id of ids) {
      const role = roleFor(id);
      if (!role) reject(400, '角色不存在。');
      if (!canGrant(role, access)) reject(403, '只能分配自己有权管理的角色。');
    }
    return ids;
  }

  function audit(actor, action, target, details = {}) {
    statement('INSERT INTO access_audit(at,actor_id,actor,action,target_id,target,details) VALUES (?,?,?,?,?,?,?)')
      .run(now(), actor.id, actor.username, action, target.id, target.username ?? target.name, JSON.stringify(details));
  }

  function beginOperation(token, permission) {
    return transaction(() => {
      const access = requirePermissions(token, permission);
      audit(access.user, permission + '.request', access.user);
      return access;
    });
  }

  function newSession(user) {
    const token = randomBytes(32).toString('base64url');
    const time = now();
    statement('DELETE FROM sessions WHERE expires<=?').run(time);
    statement('INSERT INTO sessions(token_hash,user_id,expires) VALUES (?,?,?)')
      .run(digest(token), user.id, time + SESSION_TTL_SECONDS * 1000);
    return { token, ...status(token) };
  }

  function addUser(username, salt, passwordHash, roleIds) {
    const id = randomUUID();
    if (statement('SELECT 1 FROM users WHERE name_key=?').get(username.toLowerCase())) reject(409, '用户名已存在。');
    statement('INSERT INTO users(id,username,name_key,salt,pass_hash,active) VALUES (?,?,?,?,?,1)')
      .run(id, username, username.toLowerCase(), salt, passwordHash);
    for (const role of roleIds) statement('INSERT INTO user_roles(user_id,role_id) VALUES (?,?)').run(id, role);
    return userFor(id);
  }

  async function bootstrap(input = {}) {
    if (!needsSetup()) reject(409, '管理员已经建立，请登录。');
    const username = label(input.username, '用户名');
    const salt = randomBytes(16);
    const passwordHash = await hashPassword(checkPassword(input.password), salt);
    return transaction(() => {
      if (!needsSetup()) reject(409, '管理员已经建立，请登录。');
      const user = addUser(username, salt, passwordHash, ['admin']);
      audit(user, 'setup', user);
      return newSession(user);
    });
  }

  function reserveLogin(clientKey, nameKey) {
    const client = typeof clientKey === 'string' && clientKey ? clientKey : 'local';
    const limits = [
      [digest(JSON.stringify(['account', client, nameKey])), maxFailures],
      [digest(JSON.stringify(['source', client])), 60],
    ];
    return transaction(() => {
      const time = now();
      statement('DELETE FROM login_limits WHERE started<=?').run(time - throttleWindow);
      return limits.map(([bucket, limit]) => {
        const row = statement('SELECT started, attempts FROM login_limits WHERE bucket=?').get(bucket);
        if (row && row.attempts >= limit) reject(429, '登录失败次数过多，请在十分钟后重试。');
        const started = row?.started ?? time;
        statement(`INSERT INTO login_limits(bucket,started,attempts) VALUES (?,?,1)
          ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1`).run(bucket, started);
        return { bucket, started };
      });
    });
  }

  function wrongCredentials() { reject(401, '用户名或密码不正确，或账号已停用。'); }

  async function login(input = {}, clientKey) {
    const nameKey = typeof input.username === 'string' && input.username.length <= 256
      ? input.username.trim().normalize('NFKC').toLowerCase() : '';
    const reservations = reserveLogin(clientKey, nameKey);
    if (!nameKey || typeof input.password !== 'string' || input.password.length > 256) wrongCredentials();
    const before = statement('SELECT id,salt,pass_hash FROM users WHERE name_key=?').get(nameKey);
    const hash = await hashPassword(input.password, before?.salt ?? dummySalt);
    return transaction(() => {
      const live = before && statement('SELECT active,pass_hash FROM users WHERE id=?').get(before.id);
      if (!timingSafeEqual(hash, live?.pass_hash ?? invalidHash) || !live?.active) wrongCredentials();
      for (const { bucket, started } of reservations) {
        statement('UPDATE login_limits SET attempts=attempts-1 WHERE bucket=? AND started=?').run(bucket, started);
      }
      const user = userFor(before.id);
      audit(user, 'login', user);
      return newSession(user);
    });
  }

  function logout(token) {
    return transaction(() => {
      const { user } = status(token);
      if (user) {
        statement('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
        audit(user, 'logout', user);
      }
      return status();
    });
  }

  async function changePassword(token, input = {}) {
    const access = requirePermissions(token);
    const stored = statement('SELECT salt,pass_hash FROM users WHERE id=?').get(access.user.id);
    if (!stored) reject(401, '当前会话已失效，请重新登录。');
    if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 256) reject(400, '请输入当前密码。');
    const next = checkPassword(input.newPassword);
    const currentHash = await hashPassword(input.currentPassword, stored.salt);
    if (!timingSafeEqual(currentHash, stored.pass_hash)) reject(403, '当前密码不正确。');
    const salt = randomBytes(16);
    const passwordHash = await hashPassword(next, salt);
    return transaction(() => {
      const live = requirePermissions(token);
      statement('UPDATE users SET salt=?,pass_hash=? WHERE id=?').run(salt, passwordHash, live.user.id);
      statement('DELETE FROM sessions WHERE user_id=?').run(live.user.id);
      audit(live.user, 'password.changed', live.user);
      return status();
    });
  }

  function listUsers(token) {
    return readSnapshot(() => {
      const access = requirePermissions(token, 'users.manage');
      return statement('SELECT id FROM users ORDER BY name_key,id').all().map(row => userFor(row.id))
        .filter(user => canManageUser(user, access));
    });
  }

  async function createUser(token, input = {}) {
    const initial = requirePermissions(token, 'users.manage');
    const username = label(input.username, '用户名');
    const roleIds = assignable(input.roleIds ?? ['member'], initial);
    const salt = randomBytes(16);
    const passwordHash = await hashPassword(checkPassword(input.password), salt);
    return transaction(() => {
      const access = requirePermissions(token, 'users.manage');
      assignable(roleIds, access);
      const user = addUser(username, salt, passwordHash, roleIds);
      audit(access.user, 'user.created', user, { roleIds });
      return user;
    });
  }

  function manageableUser(access, id) {
    const user = userFor(id);
    if (!user) reject(404, '找不到该用户。');
    if (!canManageUser(user, access)) reject(403, '当前账号无权管理该用户。');
    return user;
  }

  function keepAdmin(user, active, roleIds) {
    if (!user.active || !user.roleIds.includes('admin') || (active && roleIds.includes('admin'))) return;
    const other = statement(`SELECT 1 FROM user_roles r JOIN users u ON r.user_id=u.id
      WHERE u.active=1 AND r.role_id='admin' AND u.id<>? LIMIT 1`).get(user.id);
    if (!other) reject(409, '至少需要保留一位启用的管理员。');
  }

  async function updateUser(token, id, changes = {}) {
    const initial = requirePermissions(token, 'users.manage');
    manageableUser(initial, id);
    if (changes.active !== undefined && typeof changes.active !== 'boolean') reject(400, '账号启用状态无效。');
    const requestedRoles = changes.roleIds === undefined ? undefined : assignable(changes.roleIds, initial);
    const salt = changes.password === undefined ? null : randomBytes(16);
    const passwordHash = salt && await hashPassword(checkPassword(changes.password), salt);
    if (!salt && requestedRoles === undefined && changes.active === undefined) reject(400, '未指定要更新的用户设置。');
    return transaction(() => {
      const access = requirePermissions(token, 'users.manage');
      const target = manageableUser(access, id);
      const active = changes.active ?? target.active;
      const roles = requestedRoles === undefined ? target.roleIds : assignable(requestedRoles, access);
      keepAdmin(target, active, roles);
      if (changes.active !== undefined) statement('UPDATE users SET active=? WHERE id=?').run(Number(active), id);
      if (salt) statement('UPDATE users SET salt=?,pass_hash=? WHERE id=?').run(salt, passwordHash, id);
      if (!active || salt) statement('DELETE FROM sessions WHERE user_id=?').run(id);
      if (requestedRoles !== undefined) {
        statement('DELETE FROM user_roles WHERE user_id=?').run(id);
        for (const role of roles) statement('INSERT INTO user_roles(user_id,role_id) VALUES (?,?)').run(id, role);
      }
      const updated = userFor(id);
      audit(access.user, 'user.updated', updated, {
        ...(changes.active !== undefined && { active }), ...(requestedRoles !== undefined && { roleIds: roles }),
        ...(salt && { passwordReset: true }),
      });
      return updated;
    });
  }

  function deleteUser(token, id) {
    return transaction(() => {
      const access = requirePermissions(token, 'users.manage');
      const target = manageableUser(access, id);
      keepAdmin(target, false, []);
      statement('DELETE FROM users WHERE id=?').run(id);
      audit(access.user, 'user.deleted', target);
      return { id };
    });
  }

  function listRoles(token) {
    return readSnapshot(() => {
      const access = requirePermissions(token);
      if (!access.permissions.some(p => p === 'users.manage' || p === 'roles.manage')) reject(403, '没有角色查看权限。');
      return statement('SELECT id FROM roles ORDER BY builtin DESC,name_key,id').all().map(row => roleFor(row.id))
        .filter(role => canGrant(role, access));
    });
  }

  function ownRoles(token) {
    return readSnapshot(() => requirePermissions(token).user.roleIds.map(roleFor));
  }

  function writePermissions(roleId, permissions) {
    if (permissions.includes('keys.manage')) reject(403, 'OpenAI 密钥配置仅授予内置管理员角色。');
    statement('DELETE FROM role_permissions WHERE role_id=?').run(roleId);
    for (const permission of permissions) statement('INSERT INTO role_permissions(role_id,permission) VALUES (?,?)').run(roleId, permission);
  }

  function writeParents(roleId, requested, access) {
    const parentIds = uniqueStrings(requested, '上级角色');
    const forbidden = new Set(descendantIds(roleId));
    for (const id of parentIds) {
      if (id === 'admin') reject(403, '无法继承系统管理员角色。');
      if (forbidden.has(id)) reject(409, '角色不能继承自身或下级角色。');
      const parent = roleFor(id);
      if (!parent) reject(400, '上级角色不存在。');
      if (!canGrant(parent, access)) reject(403, '上级角色权限不可超出自己的权限。');
    }
    statement('DELETE FROM role_parents WHERE role_id=?').run(roleId);
    for (const id of parentIds) statement('INSERT INTO role_parents(role_id,parent_id) VALUES (?,?)').run(roleId, id);
  }

  function checkRoleName(name, id) {
    if (statement('SELECT 1 FROM roles WHERE name_key=? AND id<>?').get(name.toLowerCase(), id)) reject(409, '角色名称已存在。');
  }

  function createRole(token, input = {}) {
    return transaction(() => {
      const access = requirePermissions(token, 'roles.manage');
      const name = label(input.name, '角色名称');
      const permissions = checkedPermissions(input.permissions ?? []);
      if (!isSubset(permissions, access)) reject(403, '角色权限不可超出自己的权限。');
      const id = randomUUID();
      checkRoleName(name, id);
      statement('INSERT INTO roles(id,name,name_key,builtin) VALUES (?,?,?,0)').run(id, name, name.toLowerCase());
      writePermissions(id, permissions);
      writeParents(id, input.parentIds === undefined ? [] : input.parentIds, access);
      const role = roleFor(id);
      audit(access.user, 'role.created', role, { permissions, parentIds: role.parentIds });
      return role;
    });
  }

  function editableRole(access, id) {
    const role = roleFor(id);
    if (!role) reject(404, '找不到该角色。');
    if (role.builtin) reject(403, '系统内置角色无法更改或删除。');
    if (!hasAdminRole(access)) {
      for (const affectedId of descendantIds(id)) {
        if (!canGrant(affectedId === id ? role : roleFor(affectedId), access)) {
          reject(403, '当前账号无权管理该角色或继承它的角色。');
        }
        const members = statement('SELECT user_id FROM user_roles WHERE role_id=?').all(affectedId);
        if (members.some(row => !canManageUser(userFor(row.user_id), access))) {
          reject(403, '此操作会影响当前账号无权管理的用户。');
        }
      }
    }
    return role;
  }

  function updateRole(token, id, changes = {}) {
    return transaction(() => {
      const access = requirePermissions(token, 'roles.manage');
      const target = editableRole(access, id);
      if (changes.name === undefined && changes.permissions === undefined && changes.parentIds === undefined) {
        reject(400, '未指定要更新的角色设置。');
      }
      const name = changes.name === undefined ? target.name : label(changes.name, '角色名称');
      const permissions = changes.permissions === undefined ? target.permissions : checkedPermissions(changes.permissions);
      if (!isSubset(permissions, access)) reject(403, '角色权限不可超出自己的权限。');
      checkRoleName(name, id);
      statement('UPDATE roles SET name=?,name_key=? WHERE id=?').run(name, name.toLowerCase(), id);
      writePermissions(id, permissions);
      if (changes.parentIds !== undefined) writeParents(id, changes.parentIds, access);
      const role = roleFor(id);
      audit(access.user, 'role.updated', role, { permissions, parentIds: role.parentIds });
      return role;
    });
  }

  function deleteRole(token, id) {
    return transaction(() => {
      const access = requirePermissions(token, 'roles.manage');
      const role = editableRole(access, id);
      if (statement('SELECT 1 FROM role_parents WHERE parent_id=? LIMIT 1').get(id)) {
        reject(409, '该角色仍被其他角色继承，请先解除继承关系。');
      }
      statement('DELETE FROM roles WHERE id=?').run(id);
      audit(access.user, 'role.deleted', role);
      return { id };
    });
  }

  function listAudit(token) {
    return readSnapshot(() => {
      requirePermissions(token, 'audit.read');
      return statement(`SELECT id,at,actor_id AS actorId,actor,action,target_id AS targetId,target,details
        FROM access_audit ORDER BY id DESC LIMIT 200`).all()
        .map(row => ({ ...row, at: new Date(row.at).toISOString(), details: JSON.parse(row.details) }));
    });
  }

  return {
    ...createPersonalTasks({ db, now, transaction, readSnapshot, requirePermissions }),
    status, requirePermissions, beginOperation, bootstrap, login, logout, changePassword, listUsers, createUser, updateUser, deleteUser,
    listRoles, ownRoles, createRole, updateRole, deleteRole, listAudit, close: () => db.close(),
  };
}
