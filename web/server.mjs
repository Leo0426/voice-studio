import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSpeechBridge } from './backend/speech.mjs';
import { createOpenAISpeech, openaiAudioTypes, openaiUploadLimit, outputTypes } from './backend/openai.mjs';
import { createAccessStore } from './backend/access.mjs';
import { accountDatabase, localSetupCode, setupCodePath } from './backend/setup-code.mjs';
import { accountRoute, sessionToken } from './backend/account-routes.mjs';
import { historyRequest, runTask, taskLabel } from './backend/task-history.mjs';

const assets = fileURLToPath(new URL('./public/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };
const mimeExtensions = {
  'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
  'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
  'audio/x-caf': 'caf', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
};
const audioExtensions = new Set(['wav', 'wave', 'mp3', 'm4a', 'mp4', 'aif', 'aiff', 'aifc', 'caf', 'aac', 'flac']);
const cloudExtensions = new Set(Object.keys(openaiAudioTypes));
const cloudMimeExtensions = { ...mimeExtensions, 'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/webm': 'webm', 'video/webm': 'webm', 'video/mpeg': 'mpeg' };

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function json(res, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendPreview(req, res, data) {
  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!range || (!range[1] && !range[2])) {
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    return res.end(data);
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(data.length - 1, Number(range[2])) : data.length - 1;
  if (start > end) {
    res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + data.length });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
  res.end(data.subarray(start, end + 1));
}

async function readBody(req, limit, limitMessage) {
  if (Number(req.headers['content-length']) > limit) fail(413, limitMessage);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      req.resume();
      fail(413, limitMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function readObject(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, '请使用 JSON 提交请求。');
  const bytes = await readBody(req, 64 * 1024, '请求内容过长。');
  try {
    const obj = JSON.parse(bytes.toString('utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {}
  fail(400, '请求内容无效。');
}

async function readMultipart(req, limit, limitMessage) {
  const type = req.headers['content-type'] || '';
  if (!/^multipart\/form-data\s*;/i.test(type)) fail(415, '请以表单上传音频。');
  const bytes = await readBody(req, limit, limitMessage);
  try {
    return await new Response(bytes, { headers: { 'Content-Type': type } }).formData();
  } catch {
    fail(400, '无法读取音频表单，请重新选择文件。');
  }
}

function audioExtension(name, contentType, cloud) {
  const extension = extname(name).slice(1).toLowerCase();
  const mime = contentType?.split(';')[0].trim().toLowerCase();
  const allowed = cloud ? cloudExtensions : audioExtensions;
  const mimeMap = cloud ? cloudMimeExtensions : mimeExtensions;
  if (allowed.has(extension) && (mime === 'application/octet-stream' || mime?.startsWith('audio/') || Object.hasOwn(mimeMap, mime))) return extension;
  if ((!cloud || !extension) && Object.hasOwn(mimeMap, mime) && allowed.has(mimeMap[mime])) return mimeMap[mime];
  if (cloud) fail(415, '请选择 WAV、MP3、M4A、MP4、MPEG、MPGA、FLAC、OGG 或 WebM 文件。');
  fail(415, '请选择 WAV、MP3、M4A、AIFF、AAC、CAF 或 FLAC 音频文件。');
}

async function transcriptionInput(req, url, cloud) {
  const multipart = cloud && /^multipart\/form-data\b/i.test(req.headers['content-type'] ?? '');
  if (!multipart) {
    const filename = url.searchParams.get('filename') || '';
    const extension = audioExtension(filename, req.headers['content-type'], cloud);
    const options = url.searchParams.get('language') ?? 'zh';
    if (!['zh', 'en'].includes(options)) fail(400, '请选择中文或英语。');
    const bytes = cloud
      ? await readBody(req, openaiUploadLimit, '请选择 25 MB 以内的音频文件。')
      : await readBody(req, 50 * 1024 * 1024, '请选择 50 MiB 以内的音频文件。');
    if (!bytes.length) fail(400, '录音文件为空。');
    return { bytes, extension, options, filename };
  }
  const form = await readMultipart(req, openaiUploadLimit + 64 * 1024, '请选择 25 MB 以内的音频文件。');
  const file = form.get('file');
  if (!(file instanceof Blob) || !file.size || form.getAll('file').length !== 1) fail(400, '请选择一个包含声音的音频文件。');
  if (file.size > openaiUploadLimit) fail(413, '请选择 25 MB 以内的音频文件。');
  const extension = audioExtension(file.name ?? '', file.type || 'application/octet-stream', true);
  if (form.getAll('model').length > 1 || form.getAll('prompt').length > 1) fail(400, '请仅提交一份转写设置。');
  const options = {
    model: form.get('model'), languages: form.getAll('languages[]'), prompt: form.get('prompt'), keywords: form.getAll('keywords[]'),
  };
  const bytes = Buffer.from(await file.arrayBuffer());
  return { bytes, extension, options, filename: file.name };
}

const operations = new Map(Object.entries({
  '/api/qwen/synthesize': 'tts.local', '/api/transcribe': 'stt.local',
  '/api/openai/synthesize': 'tts.openai', '/api/openai/transcribe': 'stt.openai',
  '/api/openai/key': 'keys.manage', '/api/openai/voices': 'voices.manage',
  '/api/openai/voice-consents': 'voices.manage',
}));

export function createWorkspaceServer({ speech = createSpeechBridge(), openai = createOpenAISpeech(),
  database = accountDatabase(), access = createAccessStore({ filename: database }), setupCode,
  desktop = process.env.VOICE_STUDIO_DESKTOP_CHILD === '1', origin = process.env.VOICE_STUDIO_ORIGIN } = {}) {
  const deployed = origin ? new URL(origin) : null;
  if (deployed && (deployed.protocol !== 'https:' || deployed.origin !== origin || desktop)) {
    throw new Error('VOICE_STUDIO_ORIGIN 必须是 NAS 对外提供服务的 HTTPS 源地址。');
  }
  if (!setupCode && database === ':memory:') setupCode = randomBytes(16).toString('hex');
  if (!setupCode && access.status().needsSetup) localSetupCode(database);
  const pendingRequests = new Set();
  const server = createServer((req, res) => {
    const request = handleRequest(req, res);
    pendingRequests.add(request);
    const done = () => pendingRequests.delete(request);
    request.then(done, done);
  });
  async function handleRequest(req, res) {
    const disconnect = new AbortController();
    res.once('close', () => { if (!res.writableEnded) disconnect.abort(); });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const port = req.socket.localPort;
      const host = req.headers.host;
      if (deployed ? host !== deployed.host : !['127.0.0.1:' + port, 'localhost:' + port].includes(host)) {
        fail(403, '请求使用了未配置的访问地址。');
      }
      const base = deployed?.origin ?? 'http://' + host;
      const url = new URL(req.url, base);
      const path = url.pathname;
      const token = sessionToken(req);
      if (path.startsWith('/api/')) {
        if (methodMutates(req.method) && req.headers.origin !== base) fail(403, '请求来源无效。');
        const intendedActor = req.headers['x-voice-actor'];
        if (intendedActor && access.requirePermissions(token).user.id !== intendedActor) {
          res.setHeader('X-Voice-Account-Changed', '1');
          fail(409, '当前账号已切换，请刷新后重新操作。');
        }
        if (path === '/api/health' && req.method === 'GET') return json(res, { app: 'voice-studio' });
        if (path === '/api/history' || path.startsWith('/api/history/')) {
          const result = await historyRequest({ path, url, req, res, access, token, desktop, readBody });
          if (!res.writableEnded) json(res, result);
          return;
        }
        if (path.startsWith('/api/auth/') || path.startsWith('/api/admin/')) {
          const result = await accountRoute({ path, req, res, token, access, readObject, secure: Boolean(deployed),
            setupCode: () => setupCode ?? localSetupCode(database),
            retireSetupCode: () => {
              // A committed bootstrap is final, even if the stale code file cannot be removed.
              if (!setupCode) try { rmSync(setupCodePath(database), { force: true }); } catch { /* inert after bootstrap */ }
            },
          });
          return json(res, result);
        }
        if (path === '/api/openai/key' && req.method === 'GET') {
          access.requirePermissions(token, 'keys.manage');
          const { keySource } = await openai.config();
          return json(res, { keySource });
        }
        if (path === '/api/config' && req.method === 'GET') access.requirePermissions(token);
        else {
          const permission = operations.get(path);
          if (!permission) fail(404, '接口不存在。');
          if (req.method !== 'POST') fail(req.method === 'GET' ? 404 : 405, '该接口不支持此请求。');
          access.requirePermissions(token, permission);
          if (deployed && (permission === 'tts.local' || permission === 'stt.local')) fail(503, 'NAS 仅提供 OpenAI 引擎。');
        }
      }
      if (req.method === 'POST') {
        const authorize = () => access.beginOperation(token, operations.get(path));
        if (path === '/api/openai/key') {
          const { apiKey } = await readObject(req);
          authorize();
          return json(res, { openai: await openai.saveKey(apiKey) });
        }
        if (path === '/api/openai/voice-consents' || path === '/api/openai/voices') {
          const form = await readMultipart(req, 10 * 1024 * 1024 + 64 * 1024, '每段录音最大 10 MiB。');
          const kind = path === '/api/openai/voices' ? 'voice' : 'consent';
          authorize();
          return json(res, await openai.enrollment(kind, form, disconnect.signal));
        }
        const cloud = path.startsWith('/api/openai/');
        const provider = cloud ? openai : speech;
        const track = (task, execute) => runTask({ access, token, permission: operations.get(path), task, execute, signal: disconnect.signal });
        if (path === '/api/transcribe' || path === '/api/openai/transcribe') {
          const { bytes, extension, options, filename } = await transcriptionInput(req, url, cloud);
          const task = { kind: 'stt', engine: cloud ? 'openai' : 'whisper', format: 'txt',
            label: taskLabel(filename?.split(/[\\/]/).pop(), '录音转写') };
          const { id, result } = await track(task, () => provider.transcribe(bytes, extension, options, disconnect.signal));
          res.setHeader('X-Voice-Task-Id', id);
          return json(res, result);
        }
        if (path === '/api/qwen/synthesize' || path === '/api/openai/synthesize') {
          const input = await readObject(req);
          const format = cloud && typeof input.format === 'string' && Object.hasOwn(outputTypes, input.format) ? input.format : 'wav';
          const task = { kind: 'tts', engine: cloud ? 'openai' : 'qwen', format, label: taskLabel(input.text, '文字朗读') };
          const { id, result: audio } = await track(task, () => provider.synthesize(input, disconnect.signal));
          res.writeHead(200, { 'Content-Type': outputTypes[format], 'Content-Length': audio.length, 'X-Voice-Task-Id': id });
          return res.end(audio);
        }
        fail(404, '接口不存在。');
      }
      if (req.method !== 'GET') fail(405, '请求方法无效。');
      if (path === '/api/config') {
        const { permissions } = access.requirePermissions(token);
        const local = !deployed && (permissions.includes('tts.local') || permissions.includes('stt.local'));
        const cloud = permissions.some(id => ['tts.openai', 'stt.openai', 'voices.manage', 'keys.manage'].includes(id));
        const [device, api] = await Promise.all([local ? speech.config(disconnect.signal) : {}, cloud ? openai.config() : {}]);
        const { keySource, ...catalog } = api;
        return json(res, {
          ...(deployed && { cloudOnly: true }),
          qwen: local && permissions.includes('tts.local') ? device.qwen : { available: false },
          transcription: local && permissions.includes('stt.local') ? device.transcription : { available: false },
          openai: { available: false, ...catalog, ...(permissions.includes('keys.manage') && { keySource }) },
        });
      }
      const file = path === '/' ? 'index.html' : path.slice(1);
      const mime = types[extname(file)];
      if (!mime || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9]+$/.test(file)) fail(404, '页面不存在。');
      const content = await readFile(join(assets, file)).catch(() => fail(404, '文件不存在。'));
      if (mime === 'audio/mpeg') return sendPreview(req, res, content);
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        res.statusCode = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        json(res, { error: res.statusCode === 500 ? '本地服务出现错误，请稍后再试。' : error.message });
      }
    }
  }
  server.once('close', async () => {
    await Promise.allSettled(pendingRequests);
    access.close();
  });
  return server;
}

function methodMutates(method) { return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'; }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT || 4317);
  const server = createWorkspaceServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '端口已占用，请更改 PORT 后重试。' : '无法启动本地服务。');
    process.exitCode = 1;
  });
  const origin = process.env.VOICE_STUDIO_ORIGIN;
  server.listen(port, origin ? '0.0.0.0' : '127.0.0.1',
    () => console.log('Voice Studio   ' + (origin || ('http://127.0.0.1:' + server.address().port))));
  let shuttingDown = false;
  const desktop = process.env.VOICE_STUDIO_DESKTOP_CHILD === '1';
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (desktop) process.stdin.destroy();
    server.close();
    server.closeAllConnections();
    // Closing sockets aborts their operations. Let child exits and file cleanup finish naturally.
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  if (desktop) {
    process.stdin.once('end', shutdown);
    process.stdin.resume();
  }
}
