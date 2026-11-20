import { extname } from 'node:path';

const fileTypes = {
  mp3: 'audio/mpeg', mpeg: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/mp4',
};
const aliases = { 'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4', 'audio/x-flac': 'audio/flac', 'video/mp4': 'audio/mp4', 'video/webm': 'audio/webm' };

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function field(form, name) {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function audio(form, fieldName) {
  const file = form.get(fieldName);
  if (!(file instanceof File) || !file.size) fail(400, '请选择一段录音文件。');
  if (file.size > 10 * 1024 * 1024) fail(413, '每段录音最大 10 MiB。');
  const extension = extname(file.name).toLowerCase().slice(1);
  const declared = file.type.split(';')[0].trim().toLowerCase();
  const type = aliases[declared] ?? declared;
  const mime = !type || type === 'application/octet-stream' ? fileTypes[extension] : type;
  const standard = Object.keys(fileTypes).find(ext => fileTypes[ext] === mime);
  if (!standard) fail(415, '请选择 WAV、MP3、OGG、AAC、FLAC、WebM 或 MP4/M4A 录音。');
  return new File([file], 'recording.' + standard, { type: mime });
}

export function createVoiceEnrollment(request) {
  return async function enrollment(kind, form, signal) {
    const consent = kind === 'consent';
    const name = field(form, 'name');
    if (!name || [...name].length > 256) fail(400, '请填写 1 至 256 个字符的音色名称。');
    const body = new FormData();
    body.set('name', name);
    if (consent) {
      const language = field(form, 'language');
      if (!['zh', 'en'].includes(language)) fail(400, '请选择授权声明使用的语言。');
      body.set('language', language);
      body.set('recording', audio(form, 'recording'));
    } else {
      const id = field(form, 'consent');
      if (!/^cons_[A-Za-z0-9_-]{1,200}$/.test(id)) fail(400, '请先上传本人授权录音，或填写同一项目的授权 ID。');
      body.set('consent', id);
      body.set('type', 'audio_sample');
      body.set('audio_sample', audio(form, 'audio_sample'));
    }
    const path = consent ? 'audio/voice_consents' : 'audio/voices';
    const result = await request(path, body, {}, signal);
    const pattern = consent ? /^cons_[A-Za-z0-9_-]{1,200}$/ : /^voice_[A-Za-z0-9_-]{1,120}$/;
    if (typeof result?.id !== 'string' || !pattern.test(result.id)) {
      fail(502, 'OpenAI 未返回有效的 ID，请先在 OpenAI 音色管理页核对创建结果。');
    }
    return { id: result.id, name };
  };
}
