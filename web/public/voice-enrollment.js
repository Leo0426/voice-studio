import { can, protectedFetch } from './session.js';
const el = id => document.getElementById('enrollment-' + id);
const dialog = document.getElementById('voice-enrollment');
const phrase = {
  zh: '我是此声音的拥有者并授权OpenAI使用此声音创建语音合成模型',
  en: 'I am the owner of this voice and I consent to OpenAI using this voice to create a synthetic voice model.',
};
const consentPattern = /^cons_[A-Za-z0-9_-]{1,200}$/;
const voicePattern = /^voice_[A-Za-z0-9_-]{1,120}$/;
const modeInputs = [...dialog.querySelectorAll('input[name="consent-mode"]')];
let stage = 'consent';
let uploadedConsent = '';
let configured = false;
let configRequest = 0;
let busy = false;
let opener;
let deepLink = false;

function status(text = '', error = false, anchor = el('result')) {
  const notice = el('status');
  if (anchor.nextElementSibling !== notice) anchor.after(notice);
  notice.textContent = text;
  notice.classList.toggle('error', error);
}

function usesExistingID() {
  return modeInputs.find(input => input.checked).value === 'existing';
}

function activeConsent() {
  return usesExistingID() ? el('consent').value.trim() : uploadedConsent;
}

function render() {
  const existing = usesExistingID();
  const first = stage === 'consent';
  const sample = stage === 'sample';
  const done = stage === 'result';
  el('editor').hidden = done;
  el('result').hidden = !done;
  el('step-consent').hidden = !first;
  el('step-sample').hidden = !sample;
  el('upload-panel').hidden = existing;
  el('existing-panel').hidden = !existing;
  el('phrase').textContent = phrase[el('language').value];
  el('phrase').lang = el('language').value;
  for (const id of ['recording', 'sample']) {
    const filename = el(id).files[0]?.name;
    el(id + '-filename').textContent = filename || '未选择文件';
    el(id + '-filename').title = filename || '';
  }
  el('active-id').textContent = activeConsent();
  for (const [id, current] of [['consent', first], ['sample', sample]]) {
    const item = el('progress-' + id);
    if (current) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  el('progress-consent').classList.toggle('is-complete', sample);
  el('upload').hidden = !first || existing;
  el('next').hidden = !first || !existing;
  el('back').hidden = !sample;
  el('create').hidden = !sample;
  el('use').hidden = !done || !can('tts.openai');
  el('new').hidden = !done;
  el('upload').textContent = busy && first ? '正在上传…' : uploadedConsent ? '继续选择样本' : '上传授权并继续';
  el('create').textContent = busy && sample ? '正在创建…' : '创建音色';
  for (const input of [...modeInputs, ...['name', 'language', 'recording', 'consent', 'sample', 'back', 'next'].map(el)]) {
    input.disabled = busy;
  }
  el('upload').disabled = busy || (!configured && !uploadedConsent);
  el('create').disabled = busy || !configured;
}

async function checkAvailability() {
  const current = ++configRequest;
  configured = false;
  el('availability-box').hidden = false;
  el('availability').textContent = '正在读取项目配置…';
  el('retry').hidden = true;
  render();
  try {
    const response = await protectedFetch('/api/config', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (current !== configRequest) return;
    configured = Boolean(data.openai?.available);
    el('availability').textContent = configured ? '' : (can('keys.manage') ? '请先在账号中心的「OpenAI 密钥」中配置。' : '请联系管理员配置 OpenAI 密钥。');
    el('availability-box').hidden = configured || stage === 'result';
  } catch {
    if (current !== configRequest) return;
    el('availability').textContent = '无法读取本机配置。';
    el('retry').hidden = false;
  }
  render();
}

function focusStage() {
  if (!dialog.open) return;
  const target = stage === 'result' ? 'result-title' : stage === 'sample' ? 'sample-title' : 'name';
  el(target).focus();
}

function showStage(value) {
  stage = value;
  status();
  render();
  focusStage();
}

function openDialog(trigger) {
  if (dialog.open) return;
  opener = trigger;
  deepLink = location.hash === '#voice-create';
  dialog.showModal();
  dialog.scrollTop = 0;
  el('title').focus({ preventScroll: true });
  void checkAvailability();
}

function closeDialog() {
  if (!dialog.open) return;
  dialog.close();
  if (location.hash === '#voice-create') history.replaceState(null, '', '#tts');
  deepLink = false;
  const fallback = document.getElementById('create-custom-voice');
  const target = [opener, fallback, document.getElementById('workspace-voice'), document.getElementById('tts-provider'), document.getElementById('nav-tts')]
    .find(element => element?.getClientRects().length && !element.matches(':disabled'));
  target?.focus({ preventScroll: true });
}

function invalid(id, text) {
  const input = el(id);
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-errormessage', 'enrollment-status');
  status(text, true, input.closest('.enrollment-file') || input);
  input.focus();
}

async function advance() {
  if (busy) return;
  const consent = stage === 'consent';
  const name = el('name').value.trim();
  if (!name || [...name].length > 256) return invalid('name', '请填写 1 至 256 个字符的音色名称。');
  if (consent && usesExistingID()) {
    if (!consentPattern.test(activeConsent())) return invalid('consent', '请填写以 cons_ 开头的有效授权 ID。');
    showStage('sample');
    return;
  }
  if (consent && uploadedConsent) {
    showStage('sample');
    return;
  }
  if (!configured) return;
  const fileID = consent ? 'recording' : 'sample';
  const file = el(fileID).files[0];
  if (!file?.size || file.size > 10 * 1024 * 1024) return invalid(fileID, '请选择非空、最大 10 MiB 的录音。');
  if (!/\.(wav|mp3|mpeg|ogg|aac|flac|webm|m4a|mp4)$/i.test(file.name)) {
    return invalid(fileID, '请选择 WAV、MP3、M4A、MP4、MPEG、OGG、AAC、FLAC 或 WebM 录音。');
  }
  const body = new FormData();
  body.set('name', name);
  if (consent) {
    body.set('language', el('language').value);
    body.set('recording', file);
  } else {
    body.set('consent', activeConsent());
    body.set('audio_sample', file);
  }
  busy = true;
  render();
  status(consent ? '正在上传本人的授权录音…' : '正在创建音色…');
  let next;
  try {
    const path = consent ? '/api/openai/voice-consents' : '/api/openai/voices';
    const response = await protectedFetch(path, { method: 'POST', body, signal: AbortSignal.timeout(250000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '提交失败，请检查项目权限和录音后重试。');
    if (typeof data.id !== 'string' || !(consent ? consentPattern : voicePattern).test(data.id)) {
      throw new Error('未收到有效 ID，请前往 OpenAI 项目音色库核对创建结果。');
    }
    if (consent) {
      uploadedConsent = data.id;
      next = 'sample';
    } else {
      el('id').value = data.id;
      el('result-name').textContent = '「' + name + '」已保存到你的 OpenAI 项目。';
      next = 'result';
    }
  } catch (error) {
    status(error.name === 'TimeoutError' ? '请求超时，请先到 OpenAI 项目音色库核对创建结果。' : error.message, true);
  } finally {
    busy = false;
    if (next) showStage(next);
    else render();
  }
}

document.addEventListener('click', event => {
  const trigger = event.target.closest('#create-custom-voice, #workspace-voice');
  if (trigger) openDialog(trigger);
});
el('close').addEventListener('click', closeDialog);
dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
el('retry').addEventListener('click', () => void checkAvailability());
el('back').addEventListener('click', () => showStage('consent'));
function resetEnrollment() {
  for (const id of ['name', 'recording', 'sample', 'consent', 'id']) {
    el(id).value = '';
    el(id).removeAttribute('aria-invalid');
  }
  uploadedConsent = '';
  modeInputs[0].checked = true;
  showStage('consent');
}
el('use').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('openai-voice-created', { detail: { id: el('id').value } }));
  closeDialog();
  resetEnrollment();
});
el('new').addEventListener('click', () => {
  resetEnrollment();
  void checkAvailability();
});
el('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el('id').value);
    status('音色 ID 已复制。');
  } catch {
    el('id').focus();
    el('id').select();
    status('音色 ID 已选中，请使用系统复制快捷键。');
  }
});
dialog.addEventListener('input', event => {
  event.target.removeAttribute('aria-invalid');
  if (event.target === el('language') || event.target === el('recording')) uploadedConsent = '';
  status();
  render();
});
for (const id of ['upload', 'next', 'create']) el(id).addEventListener('click', () => void advance());
window.addEventListener('hashchange', () => {
  if (location.hash === '#voice-create') openDialog();
  else if (deepLink) closeDialog();
});
if (location.hash === '#voice-create') openDialog();
