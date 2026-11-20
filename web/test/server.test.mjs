import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { testServer } from './session-fixture.mjs';
import { createSpeechBridge } from '../backend/speech.mjs';
import { createOpenAISpeech } from '../backend/openai.mjs';

const audio = Buffer.from('RIFF-test-audio');

async function listen(t, speech, openai = createOpenAISpeech({
  environment: {}, configurationFile: '/missing-voice-studio/openai.env', fetchImpl: assert.fail,
})) {
  const { origin, headers } = await testServer(t, { speech, openai });
  return {
    get: path => fetch(origin + path, { headers }),
    post: (path, body, type, override = {}, signal) => fetch(origin + path, {
      method: 'POST', body, signal, headers: { Origin: origin, ...headers, ...(type && { 'Content-Type': type }), ...override },
    }),
  };
}

test('两种转换使用同一个本地程序，临时文件在返回结果后清理', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-bridge-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'bridge.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [command, input, output, language] = process.argv.slice(2);
if (command === 'status') console.log(JSON.stringify({available:true, voices:[{id:'Vivian'}]}));
if (command === 'transcription-status') console.log(JSON.stringify({available:true, modelInstalled:true}));
if (command === 'synthesize') {
  const { text, voice } = JSON.parse(readFileSync(0,'utf8'));
  if (text !== '你好' || voice !== 'Vivian') process.exit(1);
  writeFileSync(input, 'RIFF-test-audio');
}
if (command === 'transcribe') {
  writeFileSync(join(dirname(process.argv[1]), 'last-input'), input);
  if (readFileSync(input,'utf8') !== 'RIFF-test-audio') {
    console.error('转写失败：音频无效。'); process.exit(1);
  }
  writeFileSync(output, language === 'zh' ? '你好' : 'Hello');
}`);
  await chmod(executable, 0o700);
  const http = await listen(t, createSpeechBridge({ executable }));
  const config = await (await http.get('/api/config')).json();
  assert.equal(config.qwen.voices[0].id, 'Vivian');
  assert.equal(config.transcription.modelInstalled, true);
  const speech = await http.post('/api/qwen/synthesize', JSON.stringify({ text: ' 你好 ' }), 'application/json');
  assert.equal(speech.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await speech.arrayBuffer()), audio);
  const transcript = await http.post('/api/transcribe?filename=../../VOICE.WAV', audio, 'application/octet-stream');
  assert.equal(transcript.status, 200);
  assert.deepEqual(await transcript.json(), { text: '你好' });
  const lastInput = await readFile(join(dir, 'last-input'), 'utf8');
  assert.ok(lastInput.endsWith('/input.wav'));
  await assert.rejects(() => access(dirname(lastInput)), { code: 'ENOENT' });
  const english = await http.post('/api/transcribe?language=en', audio, 'audio/wav');
  assert.deepEqual(await english.json(), { text: 'Hello' });
  const invalid = await http.post('/api/transcribe', 'bad data', 'audio/wav');
  assert.equal(invalid.status, 422);
  assert.deepEqual(await invalid.json(), { error: '转写失败：音频无效。' });
  const failedInput = await readFile(join(dir, 'last-input'), 'utf8');
  await assert.rejects(() => access(dirname(failedInput)), { code: 'ENOENT' });
});

const offline = createSpeechBridge({ executable: '/missing-voice-studio/bridge' });

// 以 FFmpeg 编码的 8 kHz 单声道静音片段，可用标准播放器读取。
const mp3 = Buffer.from('/+MYxAAAAANIAAAAAExBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV', 'base64');
const flac = Buffer.from('ZkxhQwAAACIAUABQAAAAAAC1AfQA8AAAAAAAAAAAAAAAAAAAAAAAAAAAhAAADgYAAABmZm1wZWcAAAAA//hkCABPCQAAAHyn', 'base64');

test('无密钥也可读取模型、十三种音色与可供下载的格式', async t => {
  const http = await listen(t, offline);
  const { openai } = await (await http.get('/api/config')).json();
  assert.equal(openai.available, false);
  assert.equal(openai.models[0].id, 'gpt-audio-1.5');
  assert.equal(openai.models.find(row => row.id === 'gpt-4o-mini-tts').supportsSpeed, true);
  assert.equal(openai.voices.length, 13);
  assert.deepEqual(openai.formats, ['wav', 'mp3', 'flac']);
  assert.equal(openai.transcriptionModel, 'gpt-transcribe');
});

test('Chat 朗读选择模型与自定义声音，保留原稿，输出 MP3', async t => {
  const openai = createOpenAISpeech({ key: () => 'test-key', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-audio-mini');
    assert.deepEqual(body.audio, { format: 'mp3', voice: { id: 'voice_abc123' } });
    assert.equal(body.messages[1].content, 'Next stop?');
    for (const option of ['广播', '温暖', '稍慢', '伦敦', '最后轻声']) assert.ok(body.messages[0].content.includes(option));
    assert.equal(body.speed, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { audio: { data: mp3.toString('base64') } } }] });
  } });
  const http = await listen(t, offline, openai);
  const input = { text: 'Next stop?', model: 'gpt-audio-mini', format: 'mp3', customVoiceId: 'voice_abc123',
    style: '广播', emotion: '温暖', pace: '稍慢', accent: '伦敦', instructions: '最后轻声' };
  const response = await http.post('/api/openai/synthesize', JSON.stringify(input), 'application/json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp3);
});

test('专用 TTS 独立提交原稿、声音、语速和指令，返回二进制 FLAC', async t => {
  const text = '读'.repeat(1200);
  const openai = createOpenAISpeech({ key: () => 'test-key', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/speech');
    assert.deepEqual(JSON.parse(init.body), {
      model: 'gpt-4o-mini-tts', input: text, voice: 'verse', response_format: 'flac', speed: 1.25, instructions: '风格：平静',
    });
    return new Response(flac);
  } });
  const http = await listen(t, offline, openai);
  const input = { text, voice: 'verse', model: 'gpt-4o-mini-tts', format: 'flac', speed: 1.25, style: '平静' };
  const response = await http.post('/api/openai/synthesize', JSON.stringify(input), 'application/json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/flac');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), flac);
});

test('模型、格式、声音 ID、倍率和指令须有效，不输出与请求格式不符的音频', async t => {
  let calls = 0;
  const openai = createOpenAISpeech({ key: () => 'test-key', fetchImpl: async () => {
    calls++;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { audio: { data: flac.toString('base64') } } }] });
  } });
  const http = await listen(t, offline, openai);
  const speak = input => http.post('/api/openai/synthesize', JSON.stringify({ text: 'hi', ...input }), 'application/json');
  for (const input of [
    { model: 'unknown' }, { format: 'aac' }, { customVoiceId: 'bad id' }, { speed: 1.25 },
    { model: 'gpt-4o-mini-tts', speed: 0.1 }, { model: 'gpt-4o-mini-tts', speed: '1.0' },
    { style: [] }, { instructions: '字'.repeat(1001) }, { model: 'gpt-4o-mini-tts', text: 'x'.repeat(4097) },
  ]) assert.equal((await speak(input)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await speak({ format: 'mp3' })).status, 502);
});

function transcriptionForm(languages = [], prompt = '', keywords = []) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'sensitive-name.wav');
  for (const code of languages) form.append('languages[]', code);
  for (const term of keywords) form.append('keywords[]', term);
  if (prompt) form.set('prompt', prompt);
  return form;
}

test('表单转写支持自动识别和多种语言，转发术语及上下文并隐藏文件名', async t => {
  const upstream = [];
  const openai = createOpenAISpeech({ key: () => 'test-key', fetchImpl: async (url, { body }) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(body.get('language'), null);
    assert.equal(body.get('file').name, 'recording.wav');
    assert.equal(body.get('model'), 'gpt-transcribe');
    upstream.push([body.getAll('languages[]'), body.get('prompt'), body.getAll('keywords[]')]);
    return Response.json({ text: '你好' });
  } });
  const http = await listen(t, offline, openai);
  for (const form of [transcriptionForm(), transcriptionForm(['zh-CN', 'en', 'en', 'yue'], '录制一场采访', ['张先生', 'API v2'])]) {
    const response = await http.post('/api/openai/transcribe', form);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: '你好' });
  }
  assert.deepEqual(upstream, [[[], null, []], [['zh-cn', 'en', 'yue'], '录制一场采访', ['张先生', 'API v2']]]);
});

test('转写设置与文件错误在请求发往云端之前返回', async t => {
  const http = await listen(t, offline, createOpenAISpeech({ key: () => 'test-key', fetchImpl: assert.fail }));
  for (const form of [new FormData(), transcriptionForm(['pt-BR']), transcriptionForm([], 'x'.repeat(1001)),
    transcriptionForm([], '', ['<a>']), transcriptionForm([], '', ['bad\nterm']), transcriptionForm([], '', Array(65).fill('a'))]) {
    assert.equal((await http.post('/api/openai/transcribe', form)).status, 400);
  }
  const wrongFile = new FormData();
  wrongFile.append('file', new Blob(['not an audio file'], { type: 'text/plain' }), 'bad.txt');
  assert.equal((await http.post('/api/openai/transcribe', wrongFile)).status, 415);
});

test('网页保存密钥后直接启用 OpenAI，重新启动仍可用且接口仅返回状态', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-key-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configurationFile = join(dir, 'prefs', 'openai.env');
  const secret = 'test-only-local-settings';
  const options = {
    configurationFile, environment: {},
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer ' + secret);
      return Response.json({ text: '你好' });
    },
  };
  const http = await listen(t, offline, createOpenAISpeech(options));
  const payload = JSON.stringify({ apiKey: secret });
  const route = '/api/openai/key';
  const send = (data, type = 'application/json', headers) => http.post(route, data, type, headers);
  assert.equal((await send(payload, 'application/json', { Origin: 'https://example.org' })).status, 403);
  assert.equal((await send(payload, 'text/plain')).status, 415);
  assert.equal((await send('{}')).status, 400);
  await assert.rejects(() => access(configurationFile), { code: 'ENOENT' });
  const response = await send(payload);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.openai.available, true);
  assert.equal(body.openai.keySource, 'file');
  assert.ok(!JSON.stringify(body).includes(secret));
  const transcribe = await http.post('/api/openai/transcribe?language=zh', audio, 'audio/wav');
  assert.deepEqual(await transcribe.json(), { text: '你好' });
  const reopened = await listen(t, offline, createOpenAISpeech(options));
  const { openai } = await (await reopened.get('/api/config')).json();
  assert.deepEqual(openai, body.openai);
  assert.deepEqual(await (await reopened.get(route)).json(), { keySource: 'file' });
});

test('本地引擎缺失仍可使用 OpenAI，文本生成 WAV，上传音频保持内容与语言', async t => {
  const wav = Buffer.alloc(48);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const calls = [];
  const openai = createOpenAISpeech({
    key: () => 'test-fixture-key',
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer test-fixture-key');
      assert.equal(init.method, 'POST');
      calls.push(url);
      if (url === 'https://api.openai.com/v1/chat/completions') {
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'gpt-audio-1.5');
        assert.equal(body.store, false);
        assert.deepEqual(body.modalities, ['text', 'audio']);
        assert.deepEqual(body.audio, { voice: 'cedar', format: 'wav' });
        assert.match(body.messages[0].content, /verbatim/);
        assert.deepEqual(body.messages[1], { role: 'user', content: '你好，你吃饭了吗？' });
        return Response.json({ choices: [{ finish_reason: 'stop', message: { audio: { data: wav.toString('base64') } } }] });
      }
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(init.body.get('model'), 'gpt-transcribe');
      assert.deepEqual(init.body.getAll('languages[]'), ['zh']);
      assert.equal(init.body.has('language'), false);
      const file = init.body.get('file');
      assert.equal(file.name, 'recording.webm');
      assert.equal(file.type, 'audio/webm');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio);
      return Response.json({ text: ' 你好，你吃饭了吗？ ' });
    },
  });
  const http = await listen(t, offline, openai);
  const config = await (await http.get('/api/config')).json();
  assert.equal(config.openai.available, true);
  assert.equal(config.qwen.available, false);
  assert.ok(config.openai.voices.some(v => v.id === 'cedar'));
  assert.equal(JSON.stringify(config).includes('fixture-key'), false);
  const speech = await http.post('/api/openai/synthesize', JSON.stringify({ text: ' 你好，你吃饭了吗？ ', voice: 'cedar' }), 'application/json');
  assert.equal(speech.status, 200);
  assert.equal(speech.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await speech.arrayBuffer()), wav);
  const transcript = await http.post('/api/openai/transcribe?filename=some-private-name.WEBM&language=zh', audio, 'video/webm');
  assert.deepEqual(await transcript.json(), { text: '你好，你吃饭了吗？' });
  assert.equal(calls.length, 2);
});

test('OpenAI 输入校验与缺少密钥不会向外发送请求', async t => {
  const http = await listen(t, offline);
  const status = await (await http.get('/api/config')).json();
  assert.equal(status.openai.available, false);
  assert.match(status.openai.message, /OPENAI_API_KEY/);
  const speech = body => http.post('/api/openai/synthesize', JSON.stringify(body), 'application/json');
  assert.equal((await speech({ text: '你好' })).status, 503);
  assert.equal((await speech({ text: '一'.repeat(801) })).status, 400);
  assert.equal((await speech({ text: '你好', voice: 'Vivian' })).status, 400);
  assert.equal((await http.post('/api/openai/transcribe', audio, 'audio/wav')).status, 503);
  assert.equal((await http.post('/api/openai/transcribe', audio, 'audio/aiff')).status, 415);
  assert.equal((await http.post('/api/openai/transcribe', '', 'audio/wav')).status, 400);
  assert.equal((await http.post('/api/openai/transcribe?language=bad', audio, 'audio/wav')).status, 400);
  assert.equal((await http.post('/api/openai/transcribe', new Blob([new Uint8Array(25_000_001)]), 'audio/wav')).status, 413);
  assert.equal((await http.post('/api/openai/transcribe', audio, 'audio/wav', { Origin: 'https://example.org' })).status, 403);
});

test('OpenAI 明确报告限流、不完整音频和空转写，不回显上游凭据', async t => {
  const replies = [
    new Response('example-secret', { status: 401 }),
    new Response('example-secret', { status: 429 }),
    Response.json({ choices: [{ finish_reason: 'length', message: { audio: { data: 'YWJj' } } }] }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { audio: { data: 'YWJj' } } }] }),
    Response.json({ text: ' ' }),
  ];
  const openai = createOpenAISpeech({ key: () => 'example-secret', fetchImpl: async () => replies.shift() });
  const http = await listen(t, offline, openai);
  for (const status of [502, 429, 422, 502]) {
    const res = await http.post('/api/openai/synthesize', '{"text":"hi"}', 'application/json');
    assert.equal(res.status, status);
    assert.doesNotMatch((await res.json()).error, /example-secret/);
  }
  const empty = await http.post('/api/openai/transcribe?language=en', audio, 'audio/mpeg');
  assert.equal(empty.status, 422);
  assert.match((await empty.json()).error, /人声/);
});

test('取消网页转写会中止发往 OpenAI 的请求', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const openai = createOpenAISpeech({
    key: () => 'test-key',
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        stopped.resolve();
        reject(signal.reason);
      }, { once: true });
      started.resolve();
    }),
  });
  const http = await listen(t, offline, openai);
  const controller = new AbortController();
  const request = http.post('/api/openai/transcribe', audio, 'audio/wav', {}, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await stopped.promise;
});

test('没有本地引擎时，两项能力均给出安装提示', async t => {
  const http = await listen(t, createSpeechBridge({ executable: '/missing-voice-studio/bridge' }));
  const status = await (await http.get('/api/config')).json();
  assert.equal(status.qwen.available, false);
  assert.equal(status.transcription.available, false);
  assert.match(status.transcription.message, /Mac/);
  assert.equal((await http.post('/api/transcribe', audio, 'audio/wav')).status, 503);
});

test('检验输入格式、空文件、上传大小和同源，拦截后不启动模型', async t => {
  const http = await listen(t, {
    synthesize: assert.fail, transcribe: assert.fail,
  });
  assert.equal((await http.post('/api/qwen/synthesize', 'null', 'application/json')).status, 400);
  assert.equal((await http.post('/api/transcribe', '', 'audio/wav')).status, 400);
  assert.equal((await http.post('/api/transcribe?language=unknown', audio, 'audio/wav')).status, 400);
  assert.equal((await http.post('/api/transcribe?filename=bad.txt', 'text', 'text/plain')).status, 415);
  assert.equal((await http.post('/api/transcribe', audio, 'audio/mpeg', { Origin: 'https://example.org' })).status, 403);
  const tooLarge = new Blob([new Uint8Array(50 * 1024 * 1024 + 1)], { type: 'audio/wav' });
  assert.equal((await http.post('/api/transcribe', tooLarge, 'audio/wav')).status, 413);
});
