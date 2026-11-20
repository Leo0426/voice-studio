import { normalizeWave } from './wave.mjs';
import { outputTypes } from './openai.mjs';

const formats = { ...outputTypes, txt: 'text/plain; charset=utf-8' };
const nativeLimit = 512 * 1024 * 1024;

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

export function taskLabel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return Array.from(clean).slice(0, 80).join('') || fallback;
}

// Pin ownership when the authorized operation starts, even if the user's roles change mid-task.
export async function runTask({ access, token, permission, task, signal, execute }) {
  const owner = access.beginOperation(token, permission).user.id;
  let result;
  try {
    result = await execute();
  } catch (error) {
    access.recordTask(owner, { ...task, status: signal.aborted ? 'cancelled' : 'failed' });
    throw error;
  }
  const data = task.kind === 'stt' ? Buffer.from(result.text, 'utf8') : result;
  const id = access.recordTask(owner, { ...task, status: 'completed', data });
  access.requirePermissions(token);
  return { id, result };
}

export async function historyRequest({ path, url, req, res, access, token, desktop, readBody }) {
  const user = access.requirePermissions(token).user;
  if (path === '/api/history' && req.method === 'GET') {
    return access.listTasks(token, { cursor: url.searchParams.get('cursor'), kind: url.searchParams.get('kind') });
  }
  const download = /^\/api\/history\/([\da-f-]+)\/download$/i.exec(path);
  if (download && req.method === 'GET') {
    const { id, format, data } = access.downloadTask(token, download[1]);
    res.writeHead(200, {
      'Content-Type': formats[format],
      'Content-Disposition': 'attachment; filename="voice-studio-' + id + '.' + format + '"',
      'Content-Length': data.length,
    });
    res.end(data);
    return;
  }
  const entry = /^\/api\/history\/([\da-f-]+)$/i.exec(path);
  if (entry && req.method === 'DELETE') {
    access.deleteTask(token, entry[1]);
    return { ok: true };
  }
  const native = /^\/api\/history\/native\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.exec(path);
  if (!desktop || !native || req.method !== 'POST') fail(404, '任务接口不存在。');
  if (req.headers['x-voice-actor'] !== user.id) fail(403, '请使用发起任务的账号保存结果。');
  access.requirePermissions(token, 'desktop.manage', 'tts.local');
  const status = req.headers['x-voice-status'] ?? 'completed';
  if (!['completed', 'failed', 'cancelled'].includes(status)) fail(400, '任务状态无效。');
  let title;
  try { title = decodeURIComponent(req.headers['x-voice-label'] || ''); }
  catch { fail(400, '任务标题无效。'); }
  const completed = status === 'completed';
  if (completed && req.headers['content-type']?.split(';')[0] !== 'audio/wav') fail(415, '请提交 WAV 音频。');
  const bytes = await readBody(req, completed ? nativeLimit : 0, completed ? '单个任务的音频最多为 512 MiB。' : '未完成的任务不能包含音频。');
  if (completed && !normalizeWave(bytes)) fail(422, '无法保存，WAV 音频无效。');
  const owner = access.requirePermissions(token, 'desktop.manage', 'tts.local').user.id;
  const id = access.recordTask(owner, { id: native[1], kind: 'tts', engine: 'qwen', format: 'wav',
    label: taskLabel(title, '设备朗读'), status, data: completed ? bytes : undefined });
  return { id };
}
