import { SESSION_TTL_SECONDS, PERMISSIONS } from './access.mjs';
import { matchesSetupCode } from './setup-code.mjs';

const labels = {
  'tts.local': '本机文字转语音', 'stt.local': '本机语音转文字',
  'tts.openai': 'OpenAI 文字转语音', 'stt.openai': 'OpenAI 语音转文字',
  'voices.manage': '创建 OpenAI 自定义音色', 'keys.manage': '管理 OpenAI 密钥',
  'users.manage': '管理用户和分配角色', 'roles.manage': '管理角色和授权',
  'audit.read': '查看审计日志', 'desktop.manage': '管理本机模型和音色库',
};
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

function cookieName(req) { return 'voice_studio_session_' + req.socket.localPort; }

// Cookies span localhost ports. Only the app's own origin can supply the other half.
export function sessionToken(req) {
  const name = cookieName(req);
  const proof = req.headers['x-voice-proof'];
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{21}$/.test(proof)) return '';
  const cookies = (req.headers.cookie || '').split(';').map(value => value.trim());
  const matches = cookies.filter(value => value.startsWith(name + '='));
  const part = matches.length === 1 ? matches[0].slice(name.length + 1) : '';
  return /^[A-Za-z0-9_-]{22}$/.test(part) ? part + proof : '';
}

function sendSessionCookie(req, res, secure, part = '') {
  res.setHeader('Set-Cookie', cookieName(req) + '=' + part + '; Path=/api; HttpOnly; SameSite=Strict; Max-Age='
    + (part ? SESSION_TTL_SECONDS : 0) + (secure ? '; Secure' : ''));
}

function startBrowserSession(req, res, secure, { token, ...state }) {
  sendSessionCookie(req, res, secure, token.slice(0, 22));
  return { ...state, browserProof: token.slice(22) };
}

export async function accountRoute({ path, req, res, token, access, readObject, setupCode, retireSetupCode, secure = false }) {
  const method = req.method;
  if (path === '/api/auth/session' && method === 'GET') return access.status(token);
  if (path === '/api/auth/login' && method === 'POST') {
    const result = await access.login(await readObject(req), req.socket.remoteAddress);
    return startBrowserSession(req, res, secure, result);
  }
  if (path === '/api/auth/bootstrap' && method === 'POST') {
    if (!access.status().needsSetup) fail(409, '管理员已创建，请登录。');
    const input = await readObject(req);
    if (!matchesSetupCode(setupCode(), input.setupCode)) fail(403, '首次设置码不正确，请在本机查看。');
    const result = await access.bootstrap({ username: input.username, password: input.password });
    retireSetupCode();
    return startBrowserSession(req, res, secure, result);
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    await access.logout(token);
    sendSessionCookie(req, res, secure);
    return access.status();
  }
  access.requirePermissions(token);
  if (path === '/api/auth/password' && method === 'POST') {
    await access.changePassword(token, await readObject(req));
    sendSessionCookie(req, res, secure);
    return access.status();
  }
  if (path === '/api/auth/desktop-authorize' && method === 'POST') {
    const entering = (await readObject(req)).enter === true;
    const state = access.requirePermissions(token, 'desktop.manage', 'tts.local');
    if (entering) access.beginOperation(token, 'desktop.manage');
    return state;
  }
  if (path === '/api/auth/permissions' && method === 'GET') {
    const state = access.status(token);
    const manages = state.permissions.includes('users.manage') || state.permissions.includes('roles.manage');
    return { permissions: PERMISSIONS.map(id => ({ id, label: labels[id] })), roles: manages ? access.listRoles(token) : access.ownRoles(token) };
  }
  if (path === '/api/admin/audit' && method === 'GET') return { entries: access.listAudit(token) };
  const match = /^\/api\/admin\/(users|roles)(?:\/([A-Za-z0-9_-]+))?$/.exec(path);
  if (match) {
    const [, resource, id] = match;
    const users = resource === 'users';
    if (!id && method === 'GET') return users ? { users: access.listUsers(token) } : { roles: access.listRoles(token) };
    access.requirePermissions(token, users ? 'users.manage' : 'roles.manage');
    if (!id && method === 'POST') {
      const input = await readObject(req);
      return users ? { user: await access.createUser(token, input) } : { role: await access.createRole(token, input) };
    }
    if (id && method === 'PATCH') {
      const input = await readObject(req);
      return users ? { user: await access.updateUser(token, id, input) } : { role: await access.updateRole(token, id, input) };
    }
    if (id && method === 'DELETE') {
      if (users) await access.deleteUser(token, id);
      else await access.deleteRole(token, id);
      return { ok: true };
    }
    fail(405, '请求方法无效。');
  }
  fail(404, '接口不存在。');
}
