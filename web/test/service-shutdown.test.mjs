import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sessionHeaders } from './session-fixture.mjs';
import { setupCodePath } from '../backend/setup-code.mjs';

const service = fileURLToPath(new URL('../server.mjs', import.meta.url));
const stub = `#!/usr/bin/env node
import { renameSync, writeFileSync } from 'node:fs';
const [command, artifact] = process.argv.slice(2);
if (command === 'status') {
  console.log(JSON.stringify({ available: true, voices: [{ id: 'fixture' }] }));
} else {
  if (command === 'synthesize') writeFileSync(artifact, 'partial');
  process.on('SIGTERM', () => {
    if (command === 'transcribe') setTimeout(() => process.exit(0), 50);
  });
  const marker = process.env.BRIDGE_MARKER;
  writeFileSync(marker + '.tmp', JSON.stringify({ pid: process.pid, artifact }));
  renameSync(marker + '.tmp', marker);
  setTimeout(() => process.exit(1), 8000);
}
`;

async function waitForBridge(marker, signal) {
  while (!signal.aborted) {
    try { return JSON.parse(await readFile(marker, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20, undefined, { signal });
  }
  signal.throwIfAborted();
}

for (const [quit, path, type, body] of [
  ['stdin EOF', '/api/transcribe', 'audio/wav', 'fixture-audio'],
  ['SIGTERM', '/api/qwen/synthesize', 'application/json', JSON.stringify({ text: 'fixture-text' })],
]) {
  test('桌面服务 ' + quit + ' 时结束转换子进程并清理临时音频', { timeout: 13000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-shutdown-test-'));
    const executable = join(dir, 'bridge.mjs'), marker = join(dir, 'started'), database = join(dir, 'access.sqlite');
    await writeFile(executable, stub, { mode: 0o700 });
    const child = spawn(process.execPath, [service], { stdio: ['pipe', 'pipe', 'ignore'], env: {
      PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: dir, TMPDIR: dir, PORT: '0',
      VOICE_STUDIO_DESKTOP_CHILD: '1', VOICE_STUDIO_AUTH_DB: database, QWEN_BRIDGE: executable, BRIDGE_MARKER: marker,
    } });
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    t.after(async () => {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await rm(dir, { recursive: true, force: true });
    });
    const signal = AbortSignal.timeout(6000);
    const [announcement] = await once(lines, 'line', { signal });
    const origin = announcement.match(/^Voice Studio\s+(http:\/\/127\.0\.0\.1:\d+)$/)?.[1];
    assert.ok(origin);
    const setupCode = (await readFile(setupCodePath(database), 'utf8')).trim();
    const response = await fetch(origin + '/api/auth/bootstrap', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ username: 'tester', password: 'fixture-password', setupCode }),
    });
    assert.equal(response.status, 200);
    const headers = await sessionHeaders(response);
    const request = fetch(origin + path, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': type }, body })
      .then(result => result.status, () => 'disconnected');
    const { pid, artifact } = await waitForBridge(marker, signal);
    await access(artifact);
    const stopped = once(child, 'exit', { signal: AbortSignal.timeout(4500) });
    if (quit === 'stdin EOF') child.stdin.end();
    else child.kill('SIGTERM');
    assert.deepEqual(await stopped, [0, null]);
    assert.equal(await request, 'disconnected');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(dirname(artifact)), { code: 'ENOENT' });
  });
}
