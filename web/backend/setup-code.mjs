import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export function accountDatabase() {
  return process.env.VOICE_STUDIO_AUTH_DB || join(homedir(), 'Library', 'Application Support', 'Voice Studio', 'access.sqlite');
}

export function setupCodePath(database) {
  const filename = basename(database);
  return join(dirname(database), filename === 'access.sqlite' ? 'bootstrap-code' : filename + '.bootstrap-code');
}

// Publish a complete file atomically, even when the Mac app and npm start open together.
export function localSetupCode(database) {
  const path = setupCodePath(database);
  try { return readFileSync(path, 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomBytes(12).toString('hex');
  const code = randomBytes(16).toString('hex');
  writeFileSync(temp, code + '\n', { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
    try { linkSync(temp, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { unlinkSync(temp); }
  return readFileSync(path, 'utf8').trim();
}

export function matchesSetupCode(actual, submitted) {
  if (typeof actual !== 'string' || !actual || typeof submitted !== 'string' || !submitted.trim()) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(submitted.trim()));
}
