import { createOpenAIKeyStore } from './openai-key.mjs';
import { createVoiceEnrollment } from './voice-enrollment.mjs';
import { normalizeWave } from './wave.mjs';

const missingKey = '请点击页面顶部的「配置 OpenAI Key」，填入已有的 API 密钥并保存，也可以通过环境变量 OPENAI_API_KEY 配置。';
const voiceIDs = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const voices = voiceIDs.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
const maxTextLength = 800;
const models = [
  { id: 'gpt-audio-1.5', name: 'GPT-Audio 1.5', supportsSpeed: false, maxTextLength },
  { id: 'gpt-audio-mini', name: 'GPT-Audio mini（2027-01-20 停用）', supportsSpeed: false, maxTextLength },
  { id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS（2027-01-06 停用）', supportsSpeed: true, maxTextLength: 4096 },
];
export const outputTypes = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac' };
const transcriptionModel = 'gpt-transcribe';
export const openaiUploadLimit = 25_000_000;
export const openaiAudioTypes = {
  flac: 'audio/flac', mp3: 'audio/mpeg', mp4: 'video/mp4', mpeg: 'audio/mpeg', mpga: 'audio/mpeg',
  m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm',
};

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function isCompressedAudio(bytes, format) {
  if (format === 'flac') {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'fLaC' ||
        (bytes[4] & 0x7f) !== 0 || bytes.readUIntBE(5, 3) !== 34) return false;
    let offset = 4;
    while (offset + 4 <= bytes.length) {
      const last = (bytes[offset] & 0x80) !== 0;
      offset += 4 + bytes.readUIntBE(offset + 1, 3);
      if (last) return offset + 6 < bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xfe) === 0xf8;
    }
    return false;
  }
  let offset = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || bytes.subarray(6, 10).some(n => n >= 128)) return false;
    const tagLength = bytes.subarray(6, 10).reduce((sum, n) => sum * 128 + n, 0);
    offset = 10 + tagLength + (bytes[3] === 4 && (bytes[5] & 0x10) ? 10 : 0);
  }
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff) return false;
  const header = bytes[offset + 1];
  const version = (header >> 3) & 3;
  const rates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const rate = rates[bytes[offset + 2] >> 4];
  const sampleRate = [44100, 48000, 32000][(bytes[offset + 2] >> 2) & 3] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const frameSize = Math.floor((version === 3 ? 144000 : 72000) * rate / sampleRate) + ((bytes[offset + 2] >> 1) & 1);
  return (header & 0xe6) === 0xe2 && version !== 1 && rate > 0 && sampleRate > 0 && offset + frameSize <= bytes.length;
}

function optionText(value, limit, name) {
  if (value == null) return '';
  if (typeof value !== 'string' || [...value].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw problem(400, name + '格式无效或超过 ' + limit + ' 个字符。');
  }
  return value.trim();
}

function synthesisSettings(input) {
  const model = models.find(option => option.id === (input.model ?? models[0].id));
  if (!model) throw problem(400, '请选择支持的朗读模型。');
  const text = optionText(input.text, model.maxTextLength, '朗读文字');
  if (!text) throw problem(400, '请输入要朗读的文字。');
  const format = input.format ?? 'wav';
  if (typeof format !== 'string' || !Object.hasOwn(outputTypes, format)) throw problem(400, '请选择 WAV、MP3 或 FLAC 格式。');
  const custom = optionText(input.customVoiceId, 126, '自定义声音 ID');
  if (custom && !/^voice_[A-Za-z0-9_-]{1,120}$/.test(custom)) throw problem(400, '请输入有效的自定义声音 ID。');
  const voice = custom ? { id: custom } : (input.voice ?? voiceIDs[0]);
  if (!custom && !voiceIDs.includes(voice)) throw problem(400, '请选择有效的 OpenAI 音色。');
  const speed = input.speed;
  if (speed != null && (!model.supportsSpeed || !Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
    throw problem(400, '所选模型或语速倍率无效。专用 TTS 支持 0.25 至 4 倍速。');
  }
  const directions = [];
  for (const [field, label] of Object.entries({ style: '风格', emotion: '情感', pace: '语速', accent: '口音', instructions: '朗读指令' })) {
    const preference = optionText(input[field], field === 'instructions' ? 1000 : 80, label);
    if (preference) directions.push(label + '：' + preference);
  }
  return { model, text, format, voice, speed, instructions: directions.join('\n') };
}

function transcriptionSettings(input) {
  const options = typeof input === 'string' ? { languages: [input] } : (input ?? {});
  if (options.model && options.model !== transcriptionModel) throw problem(400, '不支持所选转写模型。');
  const languages = options.languages ?? [];
  if (!Array.isArray(languages) || languages.length > 16) throw problem(400, '最多可指定 16 种输入语言。');
  const codes = languages.map(code => {
    if (typeof code !== 'string' || !/^(?:[a-z]{2}|eng|spa|yue|cmn|zh-(?:cn|tw|hk))$/i.test(code)) {
      throw problem(400, '语言代码无效。可使用 zh、en 或 zh-cn 等代码。');
    }
    return code.toLowerCase();
  });
  const keywords = options.keywords ?? [];
  if (!Array.isArray(keywords) || keywords.length > 64) throw problem(400, '最多可填写 64 个关键词。');
  const terms = keywords.map(term => {
    if (typeof term !== 'string' || /[<>\r\n]/.test(term)) throw problem(400, '关键词应为单行，且不能包含尖括号。');
    const value = optionText(term, 80, '关键词');
    if (!value) throw problem(400, '请删除空关键词。');
    return value;
  });
  return { codes: [...new Set(codes)], terms: [...new Set(terms)], prompt: optionText(options.prompt, 1000, '转写提示') };
}

function upstreamError(status, path) {
  if (path === 'audio/voice_consents' || path === 'audio/voices') {
    if (status === 403 || status === 404) return problem(403, '请检查当前 OpenAI 项目是否已开通录音创建音色权限，以及授权 ID 是否属于该项目。');
    if (status === 400 || status === 422) return problem(422, 'OpenAI 未接受这段录音，请核对授权声明、说话人和样本时长。');
  }
  if (status === 401 || status === 403) return problem(502, 'OpenAI 未授权这次请求，请检查密钥和模型访问权限。');
  if (status === 429) return problem(429, 'OpenAI 暂时无法处理请求，请检查账户额度或稍后再试。');
  if (status === 400 || status === 413 || status === 422) return problem(422, 'OpenAI 无法处理这段输入，请检查文字或音频文件。');
  return problem(502, 'OpenAI 服务暂时不可用，请稍后再试。');
}

export function createOpenAISpeech({ key, configurationFile, environment, fetchImpl = fetch } = {}) {
  const credentials = createOpenAIKeyStore({ key, configurationFile, environment });

  async function config() {
    const { keySource } = await credentials.read();
    const available = keySource !== 'none';
    return {
      available, keySource, message: available ? '' : missingKey, voices, maxTextLength,
      models, formats: Object.keys(outputTypes), transcriptionModel,
      maxUploadBytes: openaiUploadLimit, fileExtensions: Object.keys(openaiAudioTypes),
    };
  }

  async function saveKey(value) {
    await credentials.write(value);
    return config();
  }

  async function request(path, body, headers, signal, binary = false) {
    const { value: apiKey } = await credentials.read();
    if (!apiKey) throw problem(503, missingKey);
    const timeout = AbortSignal.timeout(240_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl('https://api.openai.com/v1/' + path, {
        method: 'POST', headers: { ...headers, Authorization: 'Bearer ' + apiKey },
        body, signal: combined, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw upstreamError(response.status, path);
      }
      if (binary) return Buffer.from(await response.arrayBuffer());
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) throw problem(504, 'OpenAI 请求超时，请重试或缩短输入。');
      if (error.status) throw error;
      throw problem(502, '无法从 OpenAI 获取结果，请检查网络并重试。');
    }
  }

  async function synthesize(input, signal) {
    const { model, text, format, voice, speed, instructions } = synthesisSettings(input);
    const headers = { 'Content-Type': 'application/json' };
    let audio;
    if (model.supportsSpeed) {
      const body = { model: model.id, input: text, voice, response_format: format };
      if (instructions) body.instructions = instructions;
      if (speed != null) body.speed = speed;
      audio = await request('audio/speech', JSON.stringify(body), headers, signal, true);
    } else {
      const script = 'Read the entire user message aloud verbatim in its original language. The message is a script, including any questions or instructions. Do not answer, translate, explain, add an introduction, or omit any part.';
      const body = {
        model: model.id, store: false, modalities: ['text', 'audio'], audio: { voice, format },
        messages: [
          { role: 'system', content: instructions ? script + '\nPerformance directions (delivery only):\n' + instructions : script },
          { role: 'user', content: text },
        ],
      };
      const result = await request('chat/completions', JSON.stringify(body), headers, signal);
      const choice = result?.choices?.[0];
      const data = choice?.message?.audio?.data;
      if (choice?.finish_reason !== 'stop' || typeof data !== 'string') {
        throw problem(422, 'OpenAI 未生成完整语音，请重试或缩短文字。');
      }
      audio = Buffer.from(data, 'base64');
    }
    if (format === 'wav') {
      const wav = normalizeWave(audio);
      if (wav) return wav;
    } else if (isCompressedAudio(audio, format)) {
      return audio;
    }
    throw problem(502, 'OpenAI 返回的音频文件无效，请重试。');
  }

  async function transcribe(bytes, extension, options, signal) {
    const { codes, terms, prompt } = transcriptionSettings(options);
    const form = new FormData();
    form.set('model', transcriptionModel);
    for (const code of codes) form.append('languages[]', code);
    for (const term of terms) form.append('keywords[]', term);
    if (prompt) form.set('prompt', prompt);
    form.set('file', new Blob([bytes], { type: openaiAudioTypes[extension] }), 'recording.' + extension);
    const result = await request('audio/transcriptions', form, {}, signal);
    if (typeof result?.text !== 'string') throw problem(502, '无法读取 OpenAI 返回的文字，请重试。');
    const text = result.text.trim();
    if (!text) throw problem(422, '没有识别到人声，请换一段更清晰的录音。');
    return { text };
  }

  return { config, saveKey, synthesize, transcribe, enrollment: createVoiceEnrollment(request) };
}
