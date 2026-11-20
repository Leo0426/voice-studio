import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../../.xcbuild/Build/Products/Release/QwenTTSBridge', import.meta.url));
const installed = '/Applications/Voice Studio.app/Contents/MacOS/QwenTTSBridge';
const setupHint = '请在 Apple Silicon Mac 上构建本项目，或把 Voice Studio 安装到「应用程序」。';

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

async function findBridge(executable) {
  for (const path of executable ? [executable] : [build, installed]) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch { /* 尝试下一个安装位置 */ }
  }
}

function run(file, args, { input, signal, timeout = 5000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Wait for the child to close before releasing its temporary input/output files.
    let forceExit;
    const stop = () => {
      if (child.kill('SIGTERM')) forceExit = setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    };
    const child = execFile(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      signal?.removeEventListener('abort', stop);
      clearTimeout(forceExit);
      if (signal?.aborted) return reject(signal.reason);
      if (!error) return resolve(stdout);
      if (error.killed) return reject(problem(504, '处理超时，请重试或选择较短的音频。'));
      // 仅向网页转交本地引擎的用户提示。
      const message = stderr.split('\n').findLast(line => line.startsWith('转写失败：'));
      reject(problem(422, message || '本地处理失败，请检查输入和模型后重试。'));
    });
    signal?.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {}); // 子进程可能先于输入结束。
    child.stdin.end(input);
  });
}

async function status(file, command, fallback, signal) {
  if (!file) return fallback;
  try {
    return JSON.parse(await run(file, [command], { signal }));
  } catch {
    signal?.throwIfAborted();
    return { ...fallback, message: '请重新构建或安装当前版本的 Voice Studio。' };
  }
}

export function createSpeechBridge({ executable = process.env.QWEN_BRIDGE } = {}) {
  const active = new Set();

  async function config(signal) {
    const file = await findBridge(executable);
    const [qwen, transcription] = await Promise.all([
      status(file, 'status', { available: false, voices: [], message: setupHint }, signal),
      status(file, 'transcription-status', { available: false, modelInstalled: false, message: setupHint }, signal),
    ]);
    return { qwen, transcription };
  }

  async function withFiles(operation, work) {
    const file = await findBridge(executable);
    if (!file) throw problem(503, setupHint);
    if (active.has(operation)) throw problem(409, '上一次转换正在进行，请稍后再试。');
    active.add(operation);
    let directory;
    try {
      directory = await mkdtemp(join(tmpdir(), 'voice-studio-'));
      return await work(file, directory);
    } finally {
      active.delete(operation);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async function synthesize(input, signal) {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || [...text].length > 800) throw problem(400, '请输入 1 至 800 个字符。');
    return withFiles('tts', async (file, directory) => {
      const settings = await status(file, 'status', { available: false, message: setupHint }, signal);
      if (!settings.available) throw problem(503, settings.message);
      const voice = input.voice ?? settings.voices[0]?.id;
      if (!settings.voices.some(v => v.id === voice)) throw problem(400, '请选择有效的音色。');
      const output = join(directory, 'speech.wav');
      await run(file, ['synthesize', output], { input: JSON.stringify({ text, voice }), signal, timeout: 240_000 });
      return readFile(output);
    });
  }

  function transcribe(bytes, extension, language, signal) {
    return withFiles('stt', async (file, directory) => {
      const input = join(directory, 'input.' + extension);
      const output = join(directory, 'transcript.txt');
      await writeFile(input, bytes, { signal });
      await run(file, ['transcribe', input, output, language], { signal, timeout: 30 * 60_000 });
      const text = (await readFile(output, 'utf8')).trim();
      if (!text) throw problem(422, '没有识别到人声，请换一段更清晰的录音。');
      return { text };
    });
  }
  return { config, synthesize, transcribe };
}
