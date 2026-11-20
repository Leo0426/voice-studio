import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

const pageSize = 50;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

function isUUID(value) {
  return typeof value === 'string' && value.length === 36 && uuid.test(value);
}

function checkTask({ id, kind, engine, label, status, format, data }) {
  if (!isUUID(id)) reject(400, '任务编号无效。');
  const validConversion = (kind === 'tts' && ['qwen', 'openai'].includes(engine) && ['wav', 'mp3', 'flac'].includes(format))
    || (kind === 'stt' && ['whisper', 'openai'].includes(engine) && format === 'txt');
  if (!validConversion) reject(400, '任务类型、引擎或文件格式无效。');
  if (typeof label !== 'string' || label.length > 400 || !label.trim() || [...label].length > 200 || /[\p{Cc}\u2028\u2029]/u.test(label)) {
    reject(400, '任务名称须为 1 至 200 个单行字符。');
  }
  if (!['completed', 'failed', 'cancelled'].includes(status)) reject(400, '任务状态无效。');
  if (status === 'completed' ? !(Buffer.isBuffer(data) && data.length > 0) : data != null) {
    reject(400, '任务状态与结果文件不匹配。');
  }
}

// The position stays usable after a deletion. Bind it to the owner and keep the database-wide row count private.
function cursorFor(key, userId, sequence) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(userId));
  const position = Buffer.alloc(8);
  position.writeBigUInt64BE(BigInt(sequence));
  const ciphertext = Buffer.concat([cipher.update(position), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
}

function readCursor(key, userId, cursor) {
  const invalid = '任务分页位置无效。';
  if (typeof cursor !== 'string' || cursor.length !== 48 || !/^[\w-]+$/.test(cursor)) reject(400, invalid);
  const raw = Buffer.from(cursor, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  cipher.setAAD(Buffer.from(userId));
  cipher.setAuthTag(raw.subarray(20));
  let sequence;
  try { sequence = Number(Buffer.concat([cipher.update(raw.subarray(12, 20)), cipher.final()]).readBigUInt64BE()); }
  catch { reject(400, invalid); }
  if (!Number.isSafeInteger(sequence) || sequence < 1) reject(400, invalid);
  return sequence;
}

export function createPersonalTasks({ db, now, transaction, readSnapshot, requirePermissions }) {
  transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS personal_task_cursor_key (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), secret BLOB NOT NULL
    );
    INSERT OR IGNORE INTO personal_task_cursor_key(singleton,secret) VALUES (1,randomblob(32));
    CREATE TABLE IF NOT EXISTS personal_tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, engine TEXT NOT NULL, label TEXT NOT NULL,
      status TEXT NOT NULL, format TEXT NOT NULL, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS personal_tasks_by_user ON personal_tasks(user_id, seq DESC);
    CREATE INDEX IF NOT EXISTS personal_tasks_by_user_and_kind ON personal_tasks(user_id, kind, seq DESC);
    CREATE TABLE IF NOT EXISTS personal_task_results (
      task_seq INTEGER PRIMARY KEY REFERENCES personal_tasks(seq) ON DELETE CASCADE, data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_personal_task_ids (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS deleted_personal_tasks_by_user ON deleted_personal_task_ids(user_id);
  `));
  const { secret } = db.prepare('SELECT secret FROM personal_task_cursor_key WHERE singleton=1').get();

  function recordTask(userId, task) {
    if (!isUUID(userId)) reject(404, '任务所属账号不存在。');
    const { kind, engine, label, status, format, data, id: providedId = randomUUID() } = task ?? {};
    checkTask({ id: providedId, kind, engine, label, status, format, data });
    const id = providedId.toLowerCase();
    const bytes = data?.length ?? 0;
    return transaction(() => {
      if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) reject(404, '任务所属账号不存在。');
      if (db.prepare('SELECT 1 FROM deleted_personal_task_ids WHERE id=?').get(id)) reject(409, '该任务编号已被使用。');
      const existing = db.prepare('SELECT seq,user_id,kind,engine,label,status,format,bytes FROM personal_tasks WHERE id=?').get(id);
      if (existing) {
        const same = existing.user_id === userId && existing.kind === kind && existing.engine === engine &&
          existing.label === label && existing.status === status && existing.format === format && existing.bytes === bytes;
        if (!same || (data && !db.prepare('SELECT 1 FROM personal_task_results WHERE task_seq=? AND data=?').get(existing.seq, data))) {
          reject(409, '该任务编号已被使用。');
        }
        return id;
      }
      const { lastInsertRowid } = db.prepare(`INSERT INTO personal_tasks
        (id,user_id,kind,engine,label,status,format,created_at,bytes) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, userId, kind, engine, label, status, format, now(), bytes);
      if (data) db.prepare('INSERT INTO personal_task_results(task_seq,data) VALUES (?,?)').run(lastInsertRowid, data);
      return id;
    });
  }

  function listTasks(token, { cursor, kind } = {}) {
    return readSnapshot(() => {
      const { user } = requirePermissions(token);
      if (kind != null && kind !== 'tts' && kind !== 'stt') reject(400, '任务类型无效。');
      const size = kind ? 5 : pageSize;
      const scope = kind ? user.id + ':' + kind : user.id;
      const before = cursor == null ? undefined : readCursor(secret, scope, cursor);
      const filter = (kind ? ' AND kind=?' : '') + (before === undefined ? '' : ' AND seq<?');
      const params = [user.id];
      if (kind) params.push(kind);
      if (before !== undefined) params.push(before);
      const rows = db.prepare(`SELECT seq,id,kind,engine,label,status,format,created_at AS createdAt,bytes
        FROM personal_tasks WHERE user_id=?${filter} ORDER BY seq DESC LIMIT ?`).all(...params, size + 1);
      const nextCursor = rows.length > size ? cursorFor(secret, scope, rows[size - 1].seq) : null;
      const tasks = rows.slice(0, size).map(({ seq, createdAt, ...row }) => ({ ...row, createdAt: new Date(createdAt).toISOString() }));
      return { tasks, nextCursor };
    });
  }

  function downloadTask(token, id) {
    return readSnapshot(() => {
      const { user } = requirePermissions(token);
      const task = isUUID(id) && db.prepare('SELECT seq,id,format,status FROM personal_tasks WHERE id=? AND user_id=?')
        .get(id.toLowerCase(), user.id);
      if (!task) reject(404, '找不到该任务。');
      if (task.status !== 'completed') reject(409, '该任务没有可下载的结果。');
      const { data } = db.prepare('SELECT data FROM personal_task_results WHERE task_seq=?').get(task.seq);
      return { id: task.id, format: task.format, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
    });
  }

  function deleteTask(token, id) {
    return transaction(() => {
      const { user } = requirePermissions(token);
      const removed = isUUID(id) && db.prepare('DELETE FROM personal_tasks WHERE id=? AND user_id=?').run(id.toLowerCase(), user.id);
      if (!removed?.changes) reject(404, '找不到该任务。');
      // A delayed native retry must not bring back a task the owner already deleted.
      db.prepare('INSERT INTO deleted_personal_task_ids(id,user_id) VALUES (?,?)').run(id.toLowerCase(), user.id);
      return { id: id.toLowerCase() };
    });
  }

  return { recordTask, listTasks, downloadTask, deleteTask };
}
