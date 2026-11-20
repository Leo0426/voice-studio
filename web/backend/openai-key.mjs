import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, parseEnv } from 'node:util';

const defaultFile = join(homedir(), 'Library', 'Application Support', 'Voice Studio', 'openai.env');

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

// 旧配置继续接受可打印的 ASCII。新密钥还需能直接写成单行 dotenv 值。
function existingKey(raw) {
  const value = typeof raw === 'string' && raw.trim();
  return value && /^[!-~]+$/.test(value) ? value : undefined;
}

function replaceKey(content, value) {
  // 整项匹配也涵盖其他字段的多行引号，避免把字符串内部的同名行当作配置。
  const assignment = /^([ \t]*)(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*(?:(["'\x60])[\s\S]*?\3([^\r\n]*)|([^\r\n]*))(\r\n|\n|\r|$)/gm;
  const remaining = content.replace(assignment, (match, indent, name, quote, tail, unquoted, ending) => {
    if (name !== 'OPENAI_API_KEY') return match;
    const rest = quote ? tail : unquoted;
    const comment = rest.indexOf('#');
    return comment < 0 ? '' : indent + rest.slice(comment) + ending;
  });
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = remaining && !/[\r\n]$/.test(remaining) ? newline : '';
  const next = remaining + separator + 'OPENAI_API_KEY=' + value + newline;
  const { OPENAI_API_KEY: old, ...previousFields } = parseEnv(content);
  const { OPENAI_API_KEY: saved, ...nextFields } = parseEnv(next);
  if (saved !== value || !isDeepStrictEqual(previousFields, nextFields)) {
    throw error(409, '配置文件格式不完整，请检查 openai.env 后重试。');
  }
  return next;
}

export function createOpenAIKeyStore({ configurationFile, environment = process.env, key } = {}) {
  configurationFile ??= environment.VOICE_STUDIO_OPENAI_CONFIG || defaultFile;
  async function environmentKey() {
    return existingKey(key ? await key() : environment.OPENAI_API_KEY);
  }

  async function read() {
    const fromEnvironment = await environmentKey();
    if (fromEnvironment) return { value: fromEnvironment, keySource: 'environment' };
    try {
      const content = await readFile(configurationFile, 'utf8');
      const value = existingKey(parseEnv(content).OPENAI_API_KEY);
      if (value) return { value, keySource: 'file' };
    } catch {
      // 文件尚未建立时，网页仍可使用本地引擎并让用户填写密钥。
    }
    return { value: undefined, keySource: 'none' };
  }

  async function write(value) {
    if (await environmentKey()) {
      throw error(409, '正在使用环境变量 OPENAI_API_KEY。请在启动网页服务的环境中更改密钥。');
    }
    if (typeof value !== 'string' || !value.length || value.length > 4096 || /[^A-Za-z0-9._+/=-]/.test(value)) {
      throw error(400, '请输入有效的单行 API 密钥，请检查空格、换行及特殊字符。');
    }
    const dir = dirname(configurationFile);
    const temp = join(dir, '.openai-' + randomUUID() + '.tmp');
    let handle;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let content = '';
      try {
        content = await readFile(configurationFile, 'utf8');
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause;
      }
      const next = replaceKey(content, value);
      handle = await open(temp, 'wx', 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(next, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, configurationFile);
    } catch (cause) {
      if (cause.status === 409) throw cause;
      throw error(500, '无法保存本机密钥，请检查配置目录的写入权限。');
    } finally {
      if (handle) await rm(temp, { force: true }).catch(() => {});
    }
  }

  return { read, write };
}
