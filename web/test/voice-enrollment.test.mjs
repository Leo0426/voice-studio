import assert from 'node:assert/strict';
import test from 'node:test';
import { testServer } from './session-fixture.mjs';
import { createOpenAISpeech } from '../backend/openai.mjs';

async function workspace(t, fetchImpl, key = 'test-enrollment') {
  const openai = createOpenAISpeech({ key: () => key, configurationFile: '/missing-voice-studio/openai.env', environment: {}, fetchImpl });
  const { origin, headers: session } = await testServer(t, { openai, speech: {} });
  return (path, body, headers = {}) => fetch(origin + '/api/openai/' + path, {
    method: 'POST', body, headers: { Origin: origin, ...session, ...headers },
  });
}

function form(fileField) {
  const data = new FormData();
  data.set('name', '旁白');
  data.set(fileField, new File(['test recording'], 'private-name.webm', { type: 'audio/webm;codecs=opus' }));
  if (fileField === 'recording') data.set('language', 'zh');
  else data.set('consent', 'cons_speaker');
  return data;
}

test('本人授权录音和样本分别提交，可用已有授权重试创建', async t => {
  const paths = [];
  const post = await workspace(t, async (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.equal(init.headers.Authorization, 'Bearer test-enrollment');
    const record = path.endsWith('/voice_consents');
    assert.equal(init.body.get('name'), '旁白');
    const audio = init.body.get(record ? 'recording' : 'audio_sample');
    assert.equal(audio.name, 'recording.webm');
    assert.equal(audio.type, 'audio/webm');
    assert.equal(await audio.text(), 'test recording');
    if (record) {
      assert.equal(init.body.get('language'), 'zh');
      return Response.json({ id: 'cons_speaker' });
    }
    assert.equal(init.body.get('type'), 'audio_sample');
    assert.equal(init.body.get('consent'), 'cons_speaker');
    return paths.length === 2 ? new Response('invalid reference', { status: 422 }) : Response.json({ id: 'voice_narrator' });
  });
  const consent = await post('voice-consents', form('recording'));
  assert.equal(consent.status, 200);
  assert.equal((await consent.json()).id, 'cons_speaker');
  const first = await post('voices', form('audio_sample'));
  assert.equal(first.status, 422);
  assert.match((await first.json()).error, /录音/);
  const retry = await post('voices', form('audio_sample'));
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { id: 'voice_narrator', name: '旁白' });
  assert.deepEqual(paths, ['/v1/audio/voice_consents', '/v1/audio/voices', '/v1/audio/voices']);
});

test('上传前验证同源、文件、大小、授权 ID、语言及密钥', async t => {
  const post = await workspace(t, assert.fail, '');
  const consent = form('recording');
  assert.equal((await post('voice-consents', consent, { Origin: 'https://example.org' })).status, 403);
  assert.equal((await post('voice-consents', '{}', { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await post('voice-consents', consent)).status, 503);
  consent.set('language', 'unknown');
  assert.equal((await post('voice-consents', consent)).status, 400);
  const sample = form('audio_sample');
  sample.set('consent', 'voice_bad');
  assert.equal((await post('voices', sample)).status, 400);
  sample.set('consent', 'cons_speaker');
  sample.set('audio_sample', new File(['other'], 'a.txt', { type: 'text/plain' }));
  assert.equal((await post('voices', sample)).status, 415);
  sample.set('audio_sample', new File([], 'a.wav', { type: 'audio/wav' }));
  assert.equal((await post('voices', sample)).status, 400);
  sample.set('audio_sample', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'a.wav', { type: 'audio/wav' }));
  assert.equal((await post('voices', sample)).status, 413);
});

test('项目权限或响应无效时保留可操作的错误提示', async t => {
  const replies = [new Response('upstream-details', {status: 404}), Response.json({id:'invalid'})];
  const post = await workspace(t, () => replies.shift());
  const denied = await post('voices', form('audio_sample'));
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /项目/);
  const invalid = await post('voices', form('audio_sample'));
  assert.equal(invalid.status, 502);
});
