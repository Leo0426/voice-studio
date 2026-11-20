const el = id => document.getElementById(id);
const prefKey = 'voice-studio.cloud-preferences';
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem(prefKey)) || {}; } catch { /* Storage can be unavailable. */ }
let catalog;
const preferenceFields = ['speech-model', 'speech-voice', 'speech-format', 'cloud-languages'];
let demoVoice = '';

function renderVoiceDemo(active) {
  const select = el('speech-voice');
  const voice = active ? select.value : '';
  const demo = el('voice-demo');
  const button = el('voice-demo-toggle');
  demo.hidden = !voice;
  button.hidden = !voice || voice === 'custom';
  el('voice-demo-source').textContent = voice === 'custom'
    ? '自定义声音可使用「填入示例」生成试听。'
    : '中文示例 · OpenAI AI 生成';
  if (voice === demoVoice) return;
  demoVoice = voice;
  const audio = el('voice-demo-audio');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  el('voice-demo-status').textContent = '';
  button.setAttribute('aria-label', '试听音色 ' + (select.selectedOptions[0]?.textContent || ''));
  button.lastElementChild.textContent = '试听音色';
  button.classList.remove('is-playing');
}

function updateChoices(id, choices) {
  const select = el(id);
  const previous = select.value || preferences[id];
  select.replaceChildren(...choices.map(({ id, name }) => new Option(name, id)));
  if (choices.some(choice => choice.id === previous)) select.value = previous;
}

export function setCloudCatalog(settings) {
  if (!settings) return;
  catalog = settings;
  updateChoices('speech-model', settings.models ?? []);
  updateChoices('speech-format', (settings.formats ?? []).map(id => ({ id, name: id.toUpperCase() })));
  updateChoices('speech-voice', [...(settings.voices ?? []), { id: 'custom', name: '已授权的自定义声音…' }]);
  el('transcription-model').value = settings.transcriptionModel || 'gpt-transcribe';
}

function speechModel() {
  return catalog?.models?.find(model => model.id === el('speech-model').value);
}

export function speechTextLimit() {
  return speechModel()?.maxTextLength ?? catalog?.maxTextLength ?? 800;
}

function languageHints() {
  const mode = el('cloud-languages').value;
  const codes = mode === 'custom' ? el('language-codes').value : mode;
  return splitEntries(codes.toLowerCase());
}

function splitEntries(text) {
  return [...new Set(text.split(/[,，、;；\r\n]+/).map(word => word.trim()).filter(Boolean))];
}

function speechValidation() {
  if (el('speech-voice').value === 'custom' && !/^voice_[A-Za-z0-9_-]{1,120}$/.test(el('custom-voice-id').value.trim())) {
    return '请填写以 voice_ 开头的已授权声音 ID。';
  }
  if (speechModel()?.supportsSpeed && !el('speech-speed').validity.valid) return '请输入 0.25 至 4 之间的语速倍率。';
  return '';
}

function transcriptionValidation() {
  const languages = languageHints();
  if (el('cloud-languages').value === 'custom' && (!languages.length || languages.length > 16 ||
      languages.some(code => !/^(?:[a-z]{2}|eng|spa|yue|cmn|zh-(?:cn|tw|hk))$/.test(code)))) {
    return '请填写最多 16 个语言代码，例如 zh-TW, en。';
  }
  const keywords = splitEntries(el('transcription-keywords').value);
  if (keywords.length > 64 || keywords.some(word => [...word].length > 80 || /[<>]/.test(word))) {
    return '最多可填写 64 个关键词，每项限 80 个字符，请移除尖括号。';
  }
  return '';
}

export function renderCloudSpeech(active, busy) {
  const options = el('openai-tts-options');
  options.hidden = !active;
  options.disabled = !active || busy;
  el('local-voice-field').hidden = active;
  renderVoiceDemo(active);
  const custom = el('speech-voice').value === 'custom';
  el('custom-voice-field').hidden = !custom;
  el('custom-voice-id').disabled = !custom;
  const numeric = Boolean(speechModel()?.supportsSpeed);
  el('speed-field').hidden = !numeric;
  el('speech-speed').disabled = !numeric;
  el('pace-field').hidden = numeric;
  el('speech-pace').disabled = numeric;
  const error = active ? speechValidation() : '';
  el('speech-options-error').textContent = error;
  return !error && (!active || Boolean(speechModel() && el('speech-voice').value && el('speech-format').value));
}

export function renderCloudTranscription(active, busy) {
  const options = el('openai-stt-options');
  options.hidden = !active;
  options.disabled = !active || busy;
  el('local-language-field').hidden = active;
  const custom = el('cloud-languages').value === 'custom';
  el('language-codes-field').hidden = !custom;
  el('language-codes').disabled = !custom;
  const error = active ? transcriptionValidation() : '';
  el('transcription-options-error').textContent = error;
  return !error;
}

export function speechOptions() {
  const model = speechModel();
  const options = { model: model.id, format: el('speech-format').value };
  if (el('speech-voice').value === 'custom') options.customVoiceId = el('custom-voice-id').value.trim();
  else options.voice = el('speech-voice').value;
  for (const name of ['style', 'emotion', 'accent', 'instructions']) {
    const value = el('speech-' + name).value.trim();
    if (value) options[name] = value;
  }
  if (model.supportsSpeed) {
    if (el('speech-speed').value) options.speed = Number(el('speech-speed').value);
  } else if (el('speech-pace').value.trim()) options.pace = el('speech-pace').value.trim();
  return options;
}

export function transcriptionForm(file) {
  const form = new FormData();
  form.set('model', el('transcription-model').value);
  form.set('file', file, file.name);
  for (const code of languageHints()) form.append('languages[]', code);
  const prompt = el('transcription-prompt').value.trim();
  if (prompt) form.set('prompt', prompt);
  for (const word of splitEntries(el('transcription-keywords').value)) form.append('keywords[]', word);
  return form;
}

export function connectCloudOptions(onSpeech, onTranscription) {
  const demo = el('voice-demo-audio');
  const button = el('voice-demo-toggle');
  const setPlaying = isPlaying => {
    const label = isPlaying ? '停止试听' : '试听音色';
    button.lastElementChild.textContent = label;
    button.setAttribute('aria-label', label + ' ' + (el('speech-voice').selectedOptions[0]?.textContent || ''));
    button.classList.toggle('is-playing', isPlaying);
  };
  button.addEventListener('click', async () => {
    if (!demo.paused) { demo.pause(); return; }
    if (!/^[a-z]+$/.test(demoVoice) || demoVoice === 'custom') return;
    const voice = demoVoice;
    if (!demo.hasAttribute('src')) demo.src = '/voice-demos/' + voice + '.mp3';
    el('voice-demo-status').textContent = '';
    demo.currentTime = 0;
    el('qwen-audio').pause();
    try { await demo.play(); }
    catch (error) {
      if (voice === demoVoice && error.name !== 'AbortError') {
        el('voice-demo-status').textContent = '样例暂时无法播放，请重试。';
        demo.removeAttribute('src');
        demo.load();
      }
    }
  });
  demo.addEventListener('play', () => setPlaying(true));
  demo.addEventListener('pause', () => setPlaying(false));
  demo.addEventListener('ended', () => setPlaying(false));
  el('qwen-audio').addEventListener('play', () => demo.pause());
  el('tts-settings').addEventListener('toggle', () => { if (!el('tts-settings').open) demo.pause(); });
  if ([...el('cloud-languages').options].some(option => option.value === preferences['cloud-languages'])) {
    el('cloud-languages').value = preferences['cloud-languages'];
  }
  function remember(event) {
    const { id, value } = event.target;
    if (!preferenceFields.includes(id) || value === 'custom') return;
    preferences[id] = value;
    try { localStorage.setItem(prefKey, JSON.stringify(preferences)); } catch { /* Preferences are optional. */ }
  }
  for (const [id, render] of [['openai-tts-options', onSpeech], ['openai-stt-options', onTranscription]]) {
    const section = el(id);
    section.addEventListener('input', render);
    section.addEventListener('change', event => { remember(event); render(); });
  }
  document.addEventListener('openai-voice-created', event => {
    const id = event.detail?.id;
    if (typeof id !== 'string' || !/^voice_[A-Za-z0-9_-]{1,120}$/.test(id)) return;
    const cloudEngine = el('tts-provider').querySelector('input[value="openai"]');
    if (cloudEngine.disabled) return;
    if (!cloudEngine.checked) {
      cloudEngine.checked = true;
      cloudEngine.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el('speech-voice').value = 'custom';
    el('custom-voice-id').value = id;
    onSpeech();
  });
}
