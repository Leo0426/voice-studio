import {
  announceChange, browserProof, can, conversionReturn, forgetBrowserProof,
  protectedFetch, readSession, saveBrowserProof, watchSession,
} from './session.js';

const el = id => document.getElementById(id);
const returnTo = new URLSearchParams(location.search).get('returnTo');
const back = conversionReturn(returnTo);
const sectionPermissions = { users: 'users.manage', roles: 'roles.manage', 'openai-key': 'keys.manage', audit: 'audit.read' };
const builtinNames = { admin: '管理员', member: '成员', auditor: '审计员' };
let session, catalog, checkSession, loadingView = 0, editorAction;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function status(id, text = '', error = false) {
  const target = el(id);
  target.textContent = text;
  target.classList.toggle('error', error);
}
async function json(path, method = 'GET', body, protectedRoute = true) {
  const response = await (protectedRoute ? protectedFetch : fetch)(path, {
    method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || '请求失败，请重试。'), { status: response.status });
  return result;
}
function explain(error) {
  if (error.name === 'TimeoutError') return '请求超时，请重新读取当前状态。';
  if (error instanceof TypeError) return '无法连接本机服务，请重试。';
  return error.message;
}
function lockAndReload() {
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  document.querySelectorAll('form').forEach(form => form.reset());
  el('signed-in').hidden = true;
  el('signed-out').hidden = true;
  el('signed-actions').hidden = true;
  location.reload();
}
function roleName(id) {
  return catalog?.roles.find(role => role.id === id)?.name || builtinNames[id] || id;
}
function permissionName(id) {
  return catalog?.permissions.find(permission => permission.id === id)?.label || id;
}
function allowedSection() {
  const id = location.hash.slice(1);
  return Object.hasOwn(sectionPermissions, id) && can(sectionPermissions[id]) ? id : 'profile';
}
function currentUser() {
  el('profile-name').textContent = '当前用户 · ' + session.user.username;
  const roles = session.user.roleIds.map(id => node('span', roleName(id), 'role-pill'));
  el('my-roles').replaceChildren(...(roles.length ? roles : [node('span','尚未分配角色')]));
  el('my-permissions').replaceChildren(...(session.permissions.length ? session.permissions.map(permissionName) : ['尚未分配权限']).map(label => node('li', label)));
  el('profile-voice').hidden = !can('voices.manage');
  el('profile-tools').hidden = el('profile-voice').hidden;
}
function showKeySource(source) {
  const messages = {
    none: '尚未配置 OpenAI 密钥。',
    file: '已配置工作区密钥。可粘贴新密钥进行更换。',
    environment: '当前使用服务端环境变量 OPENAI_API_KEY。请通过部署环境更换。',
  };
  status('key-source', messages[source] ?? '正在读取密钥状态…');
  el('key-form').hidden = !['none', 'file'].includes(source);
}
function action(label, callback, danger = false) {
  const button = node('button', label, danger ? 'secondary danger-link' : 'secondary');
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}
function cellContent(element, value) {
  if (value instanceof Node) element.append(value);
  else element.textContent = value ?? '—';
}
function table(headers, rows, empty) {
  if (!rows.length) return node('p', empty, 'empty-row');
  const result = node('table'), head = result.createTHead().insertRow(), body = result.createTBody();
  for (const label of headers) { const th = node('th', label); th.scope = 'col'; head.append(th); }
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) cellContent(tr.insertCell(), value);
  }
  return result;
}
function entityActions(kind, entity, edit) {
  const box = node('div', '', 'row-actions');
  box.append(action('编辑', () => edit(entity)));
  box.append(action('删除', () => removeEntity(kind, entity), true));
  return box;
}
function userRows(users) {
  return table(['用户名','状态','角色','操作'], users.map(user => [
    user.username, user.active ? '启用' : '停用', user.roleIds.map(roleName).join('、') || '尚未分配',
    entityActions('users', user, editUser),
  ]), '还没有可管理的用户。');
}
function roleRows(roles) {
  return table(['角色名称','继承角色','有效权限','操作'], roles.map(role => {
    const effective = role.effectivePermissions || role.permissions;
    const access = node('details');
    access.append(node('summary', effective.length + ' 项权限'));
    const items = node('ul');
    items.append(...effective.map(id => node('li', permissionName(id))));
    access.append(items);
    return [role.name, (role.parentIds || []).map(roleName).join('、') || '—', access, role.builtin ? '内置角色' : entityActions('roles', role, editRole)];
  }), '还没有可管理的角色。');
}
const auditActions = { setup:'初始化管理员', login:'登录', logout:'退出登录', 'password.changed':'修改密码', 'user.created':'创建用户', 'user.updated':'更新用户', 'user.deleted':'删除用户', 'role.created':'创建角色', 'role.updated':'更新角色', 'role.deleted':'删除角色' };
function auditRows(entries) {
  return table(['发生时间','操作者','操作','对象','详情'], entries.map(entry => {
    const op = entry.action.endsWith('.request') ? permissionName(entry.action.slice(0,-8)) : auditActions[entry.action] || entry.action;
    const detail = Object.entries(entry.details || {});
    const detailNames = { roleIds:'角色', parentIds:'继承角色', permissions:'权限', active:'启用', passwordReset:'重置密码', name:'名称' };
    const info = node('details');
    info.append(node('summary', '展开'));
    for (const [key, value] of detail) {
      let display = value;
      if (Array.isArray(value)) display = value.map(item => ['roleIds','parentIds'].includes(key) ? roleName(item) : key === 'permissions' ? permissionName(item) : item).join('、');
      if (typeof value === 'boolean') display = value ? '是' : '否';
      info.append(node('p', (detailNames[key] || key) + ' · ' + display));
    }
    return [new Date(entry.at).toLocaleString('zh-CN',{hour12:false}), entry.actor || '—', op, entry.target || '—', detail.length ? info : '—'];
  }), '暂无审计记录。');
}

async function refreshView() {
  if (!session?.user?.active) return;
  const view = allowedSection(), ticket = ++loadingView;
  for (const id of ['profile', ...Object.keys(sectionPermissions)]) {
    const link = el('account-tabs').querySelector('[href="#' + id + '"]');
    link.hidden = id !== 'profile' && !can(sectionPermissions[id]);
    if (id === view) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
    el('panel-' + id).hidden = id !== view;
  }
  if (el('edit-dialog').open) el('edit-dialog').close();
  const container = el(view + '-list');
  if (container) container.replaceChildren(node('p','正在读取…','empty-row'));
  el('key-form').reset();
  status('key-status');
  if (view === 'openai-key') showKeySource();
  status('account-status');
  try {
    const [permissions, result] = await Promise.all([
      json('/api/auth/permissions'),
      view === 'openai-key' ? json('/api/openai/key') : container ? json('/api/admin/' + view) : null,
    ]);
    if (ticket !== loadingView) return;
    catalog = permissions;
    currentUser();
    if (view === 'users') container.replaceChildren(userRows(result.users));
    if (view === 'roles') container.replaceChildren(roleRows(result.roles));
    if (view === 'audit') container.replaceChildren(auditRows(result.entries));
    if (view === 'openai-key') showKeySource(result.keySource);
  } catch (error) {
    if (ticket !== loadingView) return;
    container?.replaceChildren();
    status('account-status', explain(error), true);
    el('account-status').append(' ',action('重试',refreshView));
  }
}

el('key-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = el('key-save');
  if (button.disabled || !can('keys.manage') || allowedSection() !== 'openai-key') return;
  const apiKey = el('key-input').value.trim();
  if (!apiKey || /[^A-Za-z0-9._+/=-]/.test(apiKey)) {
    status('key-status', '请输入有效的单行 API Key。', true);
    return;
  }
  const ticket = loadingView;
  button.disabled = true;
  status('key-status', '正在保存…');
  try {
    const { openai } = await json('/api/openai/key', 'POST', { apiKey });
    announceChange();
    if (ticket !== loadingView) return;
    showKeySource(openai.keySource);
    status('key-status', '密钥已保存。');
  } catch (error) {
    if (ticket === loadingView) status('key-status', explain(error), true);
  } finally {
    if (ticket === loadingView) el('key-form').reset();
    button.disabled = false;
  }
});

function field(label, type, options = {}) {
  const wrapper = node('label',label), input = node('input');
  input.type = type;
  Object.assign(input, options);
  wrapper.append(input);
  return { wrapper, input };
}
function choices(title, options, selected) {
  const box = node('fieldset', '', 'choice-group');
  box.append(node('legend', title));
  for (const { id, name } of options) {
    const label = node('label', '', 'choice-item'), check = node('input');
    check.type = 'checkbox'; check.value = id; check.checked = selected.includes(id);
    label.append(check, document.createTextNode(name));
    box.append(label);
  }
  return { box, values: () => [...box.querySelectorAll(':checked')].map(input => input.value) };
}
function sameChoices(left, right) {
  return left.length === right.length && left.every(item => right.includes(item));
}
function editor(title, fields, submit, handler, destructive = false) {
  el('edit-title').textContent = title;
  el('edit-fields').replaceChildren(...fields);
  el('edit-submit').textContent = submit;
  el('edit-submit').classList.toggle('destructive', destructive);
  status('edit-status');
  editorAction = handler;
  el('edit-dialog').showModal();
}
function editUser(user) {
  if (!catalog) return;
  const name = field('用户名','text',{required:true,maxLength:128,readOnly:Boolean(user),value:user?.username || ''});
  const password = field(user ? '重设密码（留空保留原密码）' : '初始密码（8 至 128 个字符）','password',{required:!user,minLength:8,maxLength:256,autocomplete:'new-password'});
  const assignable = catalog.roles.filter(role => (role.effectivePermissions || role.permissions).every(can) && (role.id !== 'admin' || session.user.roleIds.includes('admin')));
  const roles = choices('分配角色',assignable,user?.roleIds ?? ['member']);
  const active = field('启用账号','checkbox',{checked:user?.active ?? true});
  const fields = [name.wrapper,password.wrapper,roles.box];
  if (user) { active.wrapper.prepend(active.input); active.wrapper.className = 'choice-item'; fields.push(active.wrapper); }
  editor(user ? '编辑用户' : '创建用户',fields,user ? '保存更改' : '创建用户',async () => {
    const roleIds = roles.values();
    const body = user ? {} : { username:name.input.value.trim(),roleIds };
    if (user && active.input.checked !== user.active) body.active = active.input.checked;
    if (user && !sameChoices(roleIds, user.roleIds)) body.roleIds = roleIds;
    if (password.input.value) body.password = password.input.value;
    if (!Object.keys(body).length) return;
    await json('/api/admin/users' + (user ? '/' + encodeURIComponent(user.id) : ''),user ? 'PATCH' : 'POST',body);
  });
}
function editRole(role) {
  if (!catalog || role?.builtin) return;
  const name = field('角色名称','text',{required:true,maxLength:128,value:role?.name || ''});
  const permissions = choices('直接授予的权限',catalog.permissions.filter(({id})=>id !== 'keys.manage' && can(id)).map(p=>({id:p.id,name:p.label})),role?.permissions || []);
  const excluded = new Set(role ? [role.id] : []);
  let previousSize;
  do {
    previousSize = excluded.size;
    for (const candidate of catalog.roles) {
      if (candidate.parentIds?.some(id => excluded.has(id))) excluded.add(candidate.id);
    }
  } while (excluded.size !== previousSize);
  const candidates = catalog.roles.filter(r => r.id !== 'admin' && !excluded.has(r.id) && (r.effectivePermissions || r.permissions).every(can));
  const parents = choices('继承角色（可选）', candidates, role?.parentIds || []);
  const inherited = node('p', '', 'form-help');
  function summarize() {
    const selected = new Set(parents.values());
    const granted = new Set(candidates.filter(r => selected.has(r.id)).flatMap(r => r.effectivePermissions || r.permissions));
    inherited.textContent = granted.size ? '继承获得的权限 · ' + [...granted].map(permissionName).join('、') : '尚未继承其他角色的权限。';
  }
  summarize();
  parents.box.addEventListener('change',summarize);
  editor(role ? '编辑角色' : '创建角色',[name.wrapper,permissions.box,parents.box,inherited],role ? '保存更改' : '创建角色',async () => {
    const body = {};
    if (!role || name.input.value.trim() !== role.name) body.name = name.input.value.trim();
    if (!role || !sameChoices(permissions.values(), role.permissions)) body.permissions = permissions.values();
    if (!role || !sameChoices(parents.values(), role.parentIds || [])) body.parentIds = parents.values();
    if (!Object.keys(body).length) return;
    await json('/api/admin/roles' + (role ? '/' + encodeURIComponent(role.id) : ''),role ? 'PATCH' : 'POST',body);
  });
}
function removeEntity(kind, entity) {
  const type = kind === 'users' ? '用户' : '角色';
  const text = '确定删除' + type + '「' + (entity.username ?? entity.name) + '」？此操作无法撤销。';
  editor('删除' + type,[node('p',text)],'确认删除',()=>json('/api/admin/' + kind + '/' + encodeURIComponent(entity.id),'DELETE'),true);
}
let editing = false;
el('edit-cancel').addEventListener('click',()=>el('edit-dialog').close());
el('edit-dialog').addEventListener('cancel',event=>{if(editing) event.preventDefault();});
el('edit-dialog').addEventListener('close',()=>{el('edit-fields').replaceChildren();editorAction=null;});
el('edit-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if (editing || !editorAction) return;
  editing = true;
  el('edit-submit').disabled = true;
  el('edit-cancel').disabled = true;
  status('edit-status','正在保存…');
  try {
    await editorAction();
    el('edit-dialog').close();
    announceChange();
    await checkSession();
    await refreshView();
    if (!el('account-status').textContent) status('account-status','已保存更改。');
  } catch (error) { status('edit-status',explain(error),true); }
  finally { editing=false;el('edit-submit').disabled=false;el('edit-cancel').disabled=false; }
});
for (const [id, callback] of [['add-user',()=>editUser()],['add-role',()=>editRole()],['refresh-audit',refreshView],['reload-account',()=>location.reload()]]) el(id).addEventListener('click',callback);
window.addEventListener('hashchange',refreshView);

function signedOut(needsSetup) {
  el('bootstrap-fields').hidden = !needsSetup;
  el('confirm-password').required = needsSetup;
  el('setup-code').required = needsSetup;
  el('sign-password').minLength = needsSetup ? 8 : 1;
  el('sign-password').autocomplete = needsSetup ? 'new-password' : 'current-password';
  el('sign-title').textContent = needsSetup ? '创建首个管理员' : '登录 Voice Studio';
  el('sign-intro').textContent = needsSetup ? '为这台设备创建管理员账号，密码为 8 至 128 个字符。' : '使用管理员分配的用户名和密码登录。';
  el('sign-submit').textContent = needsSetup ? '创建管理员并登录' : '登录';
  el('signed-out').hidden=false;
}
el('sign-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if (el('sign-submit').disabled) return;
  const setup = session.needsSetup;
  if (setup && el('sign-password').value !== el('confirm-password').value) {status('sign-status','两次输入的密码不一致。',true);return;}
  el('sign-submit').disabled=true;
  status('sign-status',setup ? '正在创建管理员…' : '正在登录…');
  try {
    const body={username:el('sign-name').value.trim(),password:el('sign-password').value};
    if(setup) body.setupCode=el('setup-code').value.trim();
    const result=await json('/api/auth/' + (setup?'bootstrap':'login'),'POST',body,false);
    if(!result.user?.active) throw new Error('登录未完成，请重试。');
    saveBrowserProof(result.browserProof);
    el('sign-form').reset();
    announceChange();
    if(returnTo) location.replace(back);
    else location.reload();
  } catch(error) {
    if (error.status === 409 && setup) {
      try { session = await readSession(); signedOut(session.needsSetup); } catch { /* Keep the form available for retry. */ }
    }
    status('sign-status',explain(error),true);
  } finally {el('sign-submit').disabled=false;}
});
el('logout').addEventListener('click',async()=>{
  el('logout').disabled=true;
  const proof = browserProof();
  try {
    await json('/api/auth/logout', 'POST');
    forgetBrowserProof(proof);
    announceChange();
    lockAndReload();
  }
  catch(error){status('account-status',explain(error),true);el('logout').disabled=false;}
});
el('password-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.submitter || el('password-form').querySelector('button');
  if(button.disabled) return;
  if(el('new-password').value !== el('repeat-password').value){status('password-status','两次输入的新密码不一致。',true);return;}
  button.disabled=true;
  const proof = browserProof();
  try {
    await json('/api/auth/password','POST',{currentPassword:el('current-password').value,newPassword:el('new-password').value});
    forgetBrowserProof(proof);
    announceChange();
    location.replace('/account.html?' + new URLSearchParams({changed:'1',...(returnTo?{returnTo:back}:{})}));
  } catch(error) { status('password-status',explain(error),true);void checkSession(); }
  finally {el('password-form').reset();button.disabled=false;}
});
async function start() {
  try {
    session = await readSession();
    checkSession = watchSession(session,lockAndReload);
    el('account-loading').hidden=true;
    if (!session.user?.active) {
      signedOut(session.needsSetup);
      if(new URLSearchParams(location.search).get('changed')==='1') status('sign-status','密码已更新，请用新密码重新登录。');
      return;
    }
    el('back-workspace').href = back;
    if (back === '/history.html') el('back-workspace').textContent = '返回任务历史';
    el('signed-in').hidden=false;el('signed-actions').hidden=false;
    currentUser();
    await refreshView();
  } catch(error) {
    el('account-loading').hidden=false;status('loading-text',explain(error),true);el('reload-account').hidden=false;
  }
}
window.addEventListener('pagehide',event=>{
  document.querySelectorAll('input[type=password]').forEach(input=>{input.value='';});
  if(event.persisted){el('signed-in').hidden=true;el('signed-out').hidden=true;el('signed-actions').hidden=true;}
});
void start();
