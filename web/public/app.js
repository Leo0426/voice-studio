import { MicrophoneRecording, maxBytes } from './recording.js';
import { can, protectedFetch } from './session.js';
import { previewFormat, showAudio } from './player.js';
import { connectCloudOptions, renderCloudSpeech, renderCloudTranscription, setCloudCatalog, speechOptions, speechTextLimit, transcriptionForm } from './cloud-options.js';

const el = id => document.getElementById(id);
const localAudioTypes = {
  wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
  aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff', caf: 'audio/x-caf', aac: 'audio/aac', flac: 'audio/flac',
};
const audioTypes = {
  ...localAudioTypes, webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg',
  mpeg: 'audio/mpeg', mpga: 'audio/mpeg',
};
let config, selected, capture, capturePhase, recordingClock, synthesis, transcription;
let loadingConfig = false;
let configError = '';

function usesOpenAI(task) {
  return el(task + '-provider').querySelector('input[value="openai"]').checked;
}

function provider(task) {
  if (!can(task + (usesOpenAI(task) ? '.openai' : '.local'))) return;
  if (usesOpenAI(task)) return config?.openai;
  return task === 'tts' ? config?.qwen : config?.transcription;
}

function fileExtensions() {
  return usesOpenAI('stt') ? config?.openai?.fileExtensions ?? [] : Object.keys(localAudioTypes);
}

function uploadLimit() {
  return usesOpenAI('stt') ? config?.openai?.maxUploadBytes ?? 25_000_000 : maxBytes;
}

function limitLabel() {
  return usesOpenAI('stt') ? (uploadLimit() / 1_000_000) + ' MB' : (maxBytes / 1024 / 1024) + ' MiB';
}

function message(id, text = '', isError = false) {
  el(id).textContent = text;
  el(id).classList.toggle('error', isError);
}

async function api(url, options) {
  const response = await protectedFetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || '转换服务暂时不可用，请重试。');
  }
  return response;
}

async function loadConfig() {
  if (loadingConfig) return;
  loadingConfig = true;
  try {
    config = await (await api('/api/config', { signal: AbortSignal.timeout(15000) })).json();
    configError = '';
  } catch {
    config = undefined;
    configError = '读取本机配置失败，请刷新页面重试。';
  } finally {
    loadingConfig = false;
  }
  if (config?.cloudOnly) {
    for (const task of ['tts', 'stt']) {
      const engines = el(task + '-provider');
      const local = engines.querySelector('input[value="local"]');
      const cloud = engines.querySelector('input[value="openai"]');
      local.disabled = true;
      local.closest('label').hidden = true;
      if (!cloud.disabled) cloud.checked = true;
    }
  }
  const service = el('service-state');
  service.textContent = config?.cloudOnly ? 'NAS 服务已连接' : config ? '本机服务已连接' : '服务未连接';
  service.dataset.connected = String(Boolean(config));
  showProviders();
  renderTTS();
  renderSTT();
}

function showProviders() {
  setCloudCatalog(config?.openai);
  el('tts-description').textContent = usesOpenAI('tts')
    ? '文字和声音设置将发送至 OpenAI，生成可试听、下载的 AI 语音。'
    : '选好音色，在本机朗读文字，试听或下载音频。';
  el('stt-description').textContent = usesOpenAI('stt')
    ? '点击转写后，文件或录音与识别提示将发送至 OpenAI。'
    : '上传音频或直接录音，在本机转成文字。';
  const voice = el('qwen-voice');
  const previous = voice.value;
  const voices = config?.qwen?.voices ?? [];
  voice.replaceChildren(...voices.map(v => new Option(v.name, v.id)));
  if (voices.some(v => v.id === previous)) voice.value = previous;
  if (!voice.options.length) voice.add(new Option('暂无可用音色', ''));
  for (const [task, hintID] of [['tts', 'synthesis-setup'], ['stt', 'transcription-setup']]) {
    const settings = provider(task);
    const hint = el(hintID);
    const missing = !settings?.available || (task === 'stt' && !usesOpenAI(task) && !settings.modelInstalled);
    hint.hidden = !configError && (!config || !missing);
    if (!hint.hidden) {
      const needsKey = !configError && usesOpenAI(task);
      hint.querySelector('span').textContent = configError || (needsKey
        ? (can('keys.manage') ? '请在账号中心的「OpenAI 密钥」中配置。' : '请联系管理员配置 OpenAI 密钥。')
        : config.cloudOnly ? 'NAS 仅提供 OpenAI 引擎。请联系管理员授予 OpenAI 权限。' : settings?.message || '请在 Mac 应用中检查本地模型。');
    }
  }
  el('audio-file').accept = fileExtensions().map(ext => '.' + ext).join(',');
}

function renderTTS() {
  const cloud = usesOpenAI('tts');
  const validOptions = renderCloudSpeech(cloud, Boolean(synthesis));
  const count = [...el('synthesis-text').value.trim()].length;
  const limit = cloud ? speechTextLimit() : provider('tts')?.maxTextLength ?? 800;
  const voice = el(cloud ? 'speech-voice' : 'qwen-voice');
  const voiceName = voice.value === 'custom' ? '自定义音色' : voice.selectedOptions[0]?.textContent.split(' · ')[0];
  const voiceSummary = [cloud ? 'OpenAI' : 'Qwen', voice.value ? voiceName : ''].filter(Boolean).join(' · ');
  const speechError = el('speech-options-error').textContent;
  el('tts-snapshot').textContent = speechError ? '请检查声音设置' : voiceSummary;
  el('tts-snapshot').classList.toggle('over-limit', Boolean(speechError));
  el('text-count').textContent = count + ' / ' + limit + ' 字';
  el('text-count').classList.toggle('over-limit', count > limit);
  el('synthesis-text').setAttribute('aria-invalid', String(count > limit));
  el('sample-text').disabled = Boolean(el('synthesis-text').value || synthesis);
  el('cancel-synthesis').hidden = !synthesis;
  el('synthesis-form').setAttribute('aria-busy', String(Boolean(synthesis)));
  el('synthesis-text').setCustomValidity(count > limit ? '最多可合成 ' + limit + ' 个字符。' : '');
  el('synthesize').disabled = !provider('tts')?.available || Boolean(synthesis) || !count || count > limit || !validOptions;
  el('synthesize').querySelector('span').textContent = synthesis ? '正在生成…' : '生成语音';
  el('tts-provider').disabled = Boolean(synthesis);
  el('qwen-voice').disabled = cloud || !config?.qwen?.available || Boolean(synthesis);
  previewFormat(cloud ? el('speech-format').value || 'wav' : 'wav');
}

const macShortcuts = /Mac|iPhone|iPad/.test(navigator.platform);
el('synthesis-shortcut').textContent = macShortcuts ? '⌘ Enter' : 'Ctrl + Enter';
el('synthesize').setAttribute('aria-keyshortcuts', macShortcuts ? 'Meta+Enter' : 'Control+Enter');
el('synthesis-text').addEventListener('input', renderTTS);
el('synthesis-text').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || !(macShortcuts ? event.metaKey : event.ctrlKey)) return;
  event.preventDefault();
  if (!el('synthesize').disabled) el('synthesis-form').requestSubmit();
});
el('sample-text').addEventListener('click', () => {
  if (el('synthesis-text').value) return;
  el('synthesis-text').value = '傍晚的风吹过街角，书店的灯刚刚亮起。推开门，听见有人轻声说：欢迎，慢慢挑。';
  renderTTS();
  el('synthesis-text').focus();
});
el('cancel-synthesis').addEventListener('click', () => synthesis?.abort());
el('synthesis-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (el('synthesize').disabled) return;
  const job = new AbortController();
  const cloud = usesOpenAI('tts');
  const settings = cloud ? speechOptions() : { voice: el('qwen-voice').value };
  const format = settings.format ?? 'wav';
  synthesis = job;
  renderTTS();
  message('synthesis-status', cloud ? 'OpenAI 正在生成音频…' : '正在本机生成音频…');
  try {
    const response = await api(cloud ? '/api/openai/synthesize' : '/api/qwen/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.signal,
      body: JSON.stringify({ text: el('synthesis-text').value.trim(), ...settings }),
    });
    const blob = await response.blob();
    if (job.signal.aborted) return;
    showAudio(blob, format, cloud
      ? 'AI 合成 · OpenAI ' + settings.model + ' · ' + (settings.voice || '已授权自定义声音')
      : '由本机 Qwen 合成。');
    message('synthesis-status', '音频已生成。');
  } catch (error) {
    if (!job.signal.aborted) message('synthesis-status', error.message, true);
  } finally {
    if (job.signal.aborted) message('synthesis-status', '已取消生成。');
    synthesis = undefined;
    renderTTS();
    document.dispatchEvent(new CustomEvent('conversion-settled', { detail: { kind: 'tts' } }));
  }
});

function renderSTT() {
  const busy = Boolean(capture || transcription);
  const ready = provider('stt')?.available;
  const validOptions = renderCloudTranscription(usesOpenAI('stt'), busy);
  const cloud = usesOpenAI('stt');
  const language = el(cloud ? 'cloud-languages' : 'audio-language').selectedOptions[0]?.textContent;
  const transcriptionError = el('transcription-options-error').textContent;
  el('stt-snapshot').textContent = transcriptionError ? '请检查转写设置' : [cloud ? 'OpenAI' : 'Whisper', language].filter(Boolean).join(' · ');
  el('stt-snapshot').classList.toggle('over-limit', Boolean(transcriptionError));
  el('choose-file').disabled = busy;
  el('stt-provider').disabled = busy;
  el('audio-language').disabled = busy;
  const recording = capturePhase === 'recording';
  el('record').disabled = !recording && (!window.isSecureContext || !ready || busy || !validOptions);
  el('http-recording-hint').hidden = window.isSecureContext;
  el('record').querySelector('i').classList.toggle('live', recording);
  el('record').querySelector('span').textContent = recording ? '结束录音并转写' : '使用麦克风录音';
  el('cancel-record').hidden = !capture;
  el('transcribe').hidden = Boolean(capture);
  el('transcribe').disabled = !transcription && (!ready || !selected || Boolean(fileError(selected)) || !validOptions);
  el('transcribe').textContent = transcription ? '取消转写' : '开始转写';
  el('file-title').textContent = selected?.name ?? '选择或拖入音频文件';
  const extensions = fileExtensions();
  const commonFormats = ['wav', 'mp3', 'm4a', 'flac'].filter(ext => extensions.includes(ext));
  const formatHint = commonFormats.length ? commonFormats.join('、').toUpperCase() + ' 等 · ' : '';
  el('file-info').textContent = selected
    ? fileError(selected) || (selected.size / 1024 / 1024).toFixed(2) + ' MiB · 点击更换'
    : formatHint + '最大 ' + limitLabel();
}

function fileError(file) {
  const extension = file.name.toLowerCase().split('.').at(-1);
  if (!fileExtensions().includes(extension)) return '当前方式不支持此格式，请更换音频或转写方式。';
  if (!file.size) return '文件为空，请重新选择。';
  if (file.size > uploadLimit()) return '超过当前上限 ' + limitLabel() + '，请更换音频或转写方式。';
  return '';
}

function selectFile(file) {
  if (!file) return;
  selected = file;
  el('transcript').value = '';
  el('transcript').hidden = true;
  el('transcript-empty').hidden = false;
  el('copy').disabled = true;
  message('copy-status');
  message('transcription-status');
  renderSTT();
}

const drop = el('choose-file');
drop.addEventListener('click', () => el('audio-file').click());
el('audio-file').addEventListener('change', () => {
  selectFile(el('audio-file').files[0]);
  el('audio-file').value = '';
});
drop.addEventListener('dragover', event => {
  event.preventDefault();
  if (!drop.disabled) drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', event => {
  event.preventDefault();
  drop.classList.remove('over');
  if (!drop.disabled) selectFile(event.dataTransfer.files[0]);
});

async function transcribe() {
  if (!selected || transcription || !provider('stt')?.available || fileError(selected)) return;
  const job = new AbortController();
  const cloud = usesOpenAI('stt');
  transcription = job;
  renderSTT();
  const progress = cloud ? '正在发送音频并由 OpenAI 转写…' : '正在本机转写…';
  message('transcription-status', !cloud && !config.transcription.modelInstalled ? '正在准备本地模型并转写，首次下载可能需要几分钟…' : progress);
  try {
    const params = new URLSearchParams({ filename: selected.name, language: el('audio-language').value });
    const mime = audioTypes[selected.name.toLowerCase().split('.').at(-1)] || 'application/octet-stream';
    const path = cloud ? '/api/openai/transcribe' : '/api/transcribe?' + params;
    const response = await api(path, {
      method: 'POST', headers: cloud ? undefined : { 'Content-Type': mime },
      body: cloud ? transcriptionForm(selected) : selected, signal: job.signal,
    });
    const { text } = await response.json();
    if (job.signal.aborted) return;
    if (typeof text !== 'string') throw new Error('没有收到转写结果，请重试。');
    el('transcript').value = text.trim();
    const empty = !el('transcript').value;
    el('transcript').hidden = empty;
    el('transcript-empty').hidden = !empty;
    el('copy').disabled = empty;
    if (!cloud && config?.transcription) {
      config.transcription.modelInstalled = true;
      el('transcription-setup').hidden = true;
    }
    message('transcription-status', empty ? '未识别到语音。' : '转写完成。');
    message('copy-status');
  } catch (error) {
    message('transcription-status', job.signal.aborted ? '转写已取消。' : error.message, !job.signal.aborted);
  } finally {
    transcription = undefined;
    renderSTT();
    document.dispatchEvent(new CustomEvent('conversion-settled', { detail: { kind: 'stt' } }));
  }
}

el('transcribe').addEventListener('click', () => transcription ? transcription.abort() : void transcribe());
el('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el('transcript').value);
    message('copy-status', '文字已复制。');
  } catch {
    el('transcript').focus();
    el('transcript').select();
    message('copy-status', '文字已选中，请使用系统复制快捷键。');
  }
});

function cancelCapture() {
  clearInterval(recordingClock);
  capture?.close();
  capture = undefined;
  capturePhase = undefined;
  renderSTT();
}

async function finishCapture(submit = true) {
  if (capturePhase !== 'recording') return;
  const mic = capture;
  capturePhase = 'finishing';
  clearInterval(recordingClock);
  renderSTT();
  try {
    const blob = await mic.finish();
    if (capture !== mic) return;
    cancelCapture();
    selectFile(new File([blob], '麦克风录音.wav', { type: 'audio/wav' }));
    if (submit) await transcribe();
    else message('transcription-status', '已达到 ' + limitLabel() + ' 上限，录音已停止。可点击「开始转写」。');
  } catch (error) {
    if (capture !== mic) return;
    cancelCapture();
    message('transcription-status', error.message, true);
  }
}

el('record').addEventListener('click', async () => {
  if (capturePhase === 'recording') { await finishCapture(); return; }
  if (capture || transcription || !provider('stt')?.available) return;
  const mic = new MicrophoneRecording(() => void finishCapture(false), text => {
    if (mic !== capture) return;
    cancelCapture();
    message('transcription-status', text, true);
  }, uploadLimit());
  capture = mic;
  capturePhase = 'requesting';
  renderSTT();
  message('transcription-status', '请允许浏览器使用麦克风。');
  try {
    await mic.start();
    if (capture !== mic) return;
    capturePhase = 'recording';
    renderSTT();
    const started = Date.now();
    function tick() {
      const seconds = Math.floor((Date.now() - started) / 1000);
      message('transcription-status', '正在录音 · ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'));
    }
    tick();
    recordingClock = setInterval(tick, 1000);
  } catch (error) {
    if (capture !== mic) return;
    cancelCapture();
    const errors = {
      NotAllowedError: '麦克风权限未开启。可在浏览器中允许麦克风，或选择音频文件。',
      NotFoundError: '未找到麦克风，请连接设备或选择音频文件。',
      NotReadableError: '麦克风暂时不可用，请检查设备后重试。',
    };
    message('transcription-status', errors[error.name] || error.message, true);
  }
});
el('cancel-record').addEventListener('click', () => { cancelCapture(); message('transcription-status', '录音已取消。'); });

for (const [task, statusID] of [['tts', 'synthesis-status'], ['stt', 'transcription-status']]) {
  el(task + '-provider').addEventListener('change', () => {
    message(statusID);
    showProviders();
    renderTTS();
    renderSTT();
    if (!provider(task)?.available) void loadConfig();
  });
}

function navigate() {
  const allowSTT = can('stt.local') || can('stt.openai');
  const allowTTS = can('tts.local') || can('tts.openai');
  const stt = allowSTT && (location.hash === '#stt' || !allowTTS);
  const denied = {
    '#openai-key': !can('keys.manage') && '当前账号没有管理 OpenAI 密钥的权限。',
    '#voice-create': !can('voices.manage') && '当前账号没有创建自定义音色的权限。',
    '#stt': !allowSTT && allowTTS && '当前账号可使用文字转语音。',
    '#tts': !allowTTS && allowSTT && '当前账号可使用语音转文字。',
  }[location.hash];
  el('workspace-notice').hidden = !denied;
  el('workspace-notice').textContent = denied || '';
  if (location.hash === '#openai-key' && can('keys.manage')) {
    location.replace('/account.html#openai-key');
    return;
  }
  el('workspace-access').hidden = allowTTS || allowSTT;
  el('nav-stt').hidden = !allowSTT;
  el('nav-tts').hidden = !allowTTS;
  el('stt-view').hidden = !allowSTT || !stt;
  el('tts-view').hidden = !allowTTS || stt;
  el(stt ? 'nav-stt' : 'nav-tts').setAttribute('aria-current', 'page');
  el(stt ? 'nav-tts' : 'nav-stt').removeAttribute('aria-current');
  document.title = (stt ? '语音转文字' : '文字转语音') + ' · Voice Studio';
  if (!provider(stt ? 'stt' : 'tts')?.available || (stt && !usesOpenAI('stt') && !config?.transcription.modelInstalled)) void loadConfig();
  if (stt) {
    el('qwen-audio').pause();
    el('voice-demo-audio').pause();
  }
  else if (capture) { cancelCapture(); message('transcription-status', '录音已取消。'); }
}

el('qwen-voice').addEventListener('change', renderTTS);
el('audio-language').addEventListener('change', renderSTT);
const compactLayout = window.matchMedia('(max-width: 700px)');
function fitSettings() {
  for (const task of ['tts', 'stt']) el(task + '-settings').open = !compactLayout.matches;
}
fitSettings();
compactLayout.addEventListener('change', fitSettings);

document.querySelector('.skip').addEventListener('click', event => { event.preventDefault(); el('main').focus(); });
window.addEventListener('hashchange', navigate);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void loadConfig();
});
window.addEventListener('pagehide', () => {
  el('voice-demo-audio').pause();
  cancelCapture();
  synthesis?.abort();
  transcription?.abort();
});
connectCloudOptions(renderTTS, renderSTT);
if (new URLSearchParams(location.search).get('engine') === 'openai') {
  el(location.hash === '#stt' ? 'stt-provider' : 'tts-provider').querySelector('input[value="openai"]').checked = true;
}
for (const task of ['tts','stt']) {
  const engines = [...el(task + '-provider').querySelectorAll('input')];
  for (const input of engines) {
    input.disabled = !can(task + '.' + input.value);
    input.closest('label').hidden = input.disabled;
  }
  if (engines.find(input => input.checked)?.disabled) {
    const permitted = engines.find(input => !input.disabled);
    if (permitted) permitted.checked = true;
  }
}
navigate();
