import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parseEnv } from 'node:util';
import { createOpenAISpeech } from '../backend/openai.mjs';

async function fixture(t, environment = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-web-key-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configurationFile = join(dir, 'config', 'openai.env');
  const options = { configurationFile, environment, fetchImpl: assert.fail };
  return { file: configurationFile, options, speech: createOpenAISpeech(options) };
}

test('首次保存到私有文件并在重新打开时识别，不返回密钥', async t => {
  const { file, options, speech } = await fixture(t);
  assert.equal((await speech.config()).keySource, 'none');
  const value = 'fixture_A-B9./+=';
  const saved = await speech.saveKey(value);
  assert.deepEqual(saved, await createOpenAISpeech(options).config());
  assert.equal(saved.available, true);
  assert.equal(saved.keySource, 'file');
  assert.ok(!JSON.stringify(saved).includes(value));
  assert.equal(parseEnv(await readFile(file, 'utf8')).OPENAI_API_KEY, value);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(file)), ['openai.env']);
});

test('原子替换已有文件，保留其他字段、注释和换行，清除重复密钥', async t => {
  const { file, speech } = await fixture(t);
  await mkdir(dirname(file));
  const unrelated = '# heading\r\nNOTES="a\r\nOPENAI_API_KEY=inside-string\r\nz"\r\n';
  const original = unrelated +
    'export OPENAI_API_KEY = "first#value"  # 用户备注\r\n' +
    'OTHER=1  # 保留\r\nOPENAI_API_KEY=second # 第二条\r\nEND=1';
  await writeFile(file, original);
  await chmod(file, 0o644);
  const oldFile = await open(file, 'r');
  t.after(() => oldFile.close());
  const value = 'replacement-123';
  await speech.saveKey(value);
  const after = await readFile(file, 'utf8');
  assert.equal(await oldFile.readFile('utf8'), original);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(after.startsWith(unrelated));
  assert.ok(after.includes('# 用户备注\r\nOTHER=1  # 保留\r\n# 第二条\r\nEND=1\r\n'));
  assert.equal(after.includes('first#value'), false);
  assert.equal(after.includes('=second'), false);
  assert.deepEqual(parseEnv(after), { ...parseEnv(original), OPENAI_API_KEY: value });
  assert.deepEqual(await readdir(dirname(file)), ['openai.env']);
});

test('拒绝覆盖来自进程的密钥，环境移除后恢复共享文件', async t => {
  const environment = {};
  const { file, speech } = await fixture(t, environment);
  await speech.saveKey('file-key');
  const before = await readFile(file, 'utf8');
  environment.OPENAI_API_KEY = ' environment-key ';
  const status = await speech.config();
  assert.equal(status.keySource, 'environment');
  assert.equal(status.available, true);
  assert.ok(!JSON.stringify(status).includes('environment-key'));
  await assert.rejects(speech.saveKey('replacement-key'), { status: 409 });
  assert.equal(await readFile(file, 'utf8'), before);
  delete environment.OPENAI_API_KEY;
  assert.equal((await speech.config()).keySource, 'file');
});

test('拒绝空值、特殊字符、控制符及多行输入，失败时文件和错误信息均不含提交值', async t => {
  const { file, speech } = await fixture(t);
  await speech.saveKey('initial-value');
  const before = await readFile(file, 'utf8');
  const invalid = [
    '', null, false, 123, ['x'], {}, 'first\nSECOND=1', 'key\n', 'key\r', 'value with space',
    ' key', 'key ', 'abc\0def', 'a\tb', 'a#b', 'a"b', "a'b", 'a\\b', 'a$b', 'a;b',
    'a|b', 'a\x60b', 'a(b)', 'a~b', '含中文', 'x'.repeat(4097),
  ];
  for (const value of invalid) {
    await assert.rejects(speech.saveKey(value), error => {
      assert.equal(error.status, 400);
      if (typeof value === 'string' && value.length > 1) assert.ok(!error.message.includes(value));
      return true;
    });
  }
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readdir(dirname(file)), ['openai.env']);
});

test('并发写入只有一条完整密钥并保留其他字段', async t => {
  const { file, speech } = await fixture(t);
  await mkdir(dirname(file));
  await writeFile(file, 'OTHER=keep\nOPENAI_API_KEY=old');
  const values = Array.from({ length: 12 }, (_, index) => 'value-' + index);
  await Promise.all(values.map(value => speech.saveKey(value)));
  const result = await readFile(file, 'utf8');
  assert.ok(values.includes(parseEnv(result).OPENAI_API_KEY));
  assert.equal(result.split('OPENAI_API_KEY=').length, 2);
  assert.equal(parseEnv(result).OTHER, 'keep');
  assert.deepEqual(await readdir(dirname(file)), ['openai.env']);
});

test('文件不能安全覆盖时，返回通用错误并保持原内容', async t => {
  const { file, speech } = await fixture(t);
  await mkdir(file, { recursive: true });
  await writeFile(join(file, 'note'), 'leave intact');
  await assert.rejects(speech.saveKey('some-private-value'), error => {
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes('some-private-value'));
    assert.ok(!error.message.includes(file));
    return true;
  });
  assert.equal(await readFile(join(file, 'note'), 'utf8'), 'leave intact');
  assert.deepEqual(await readdir(dirname(file)), ['openai.env']);
});
