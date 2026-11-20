import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAISpeech } from '../backend/openai.mjs';

const unknown = 0xffffffff;
// Mono 24 kHz PCM16, as returned by the speech endpoint, with deterministic test samples.
const pcmFormat = Buffer.from('01000100c05d000080bb000002001000', 'hex');
const samples = Buffer.from('0100020003000400', 'hex');

function chunk(name, payload, declared = payload.length) {
  const block = Buffer.alloc(8 + payload.length + payload.length % 2);
  block.write(name);
  block.writeUInt32LE(declared, 4);
  payload.copy(block, 8);
  return block;
}

function riff(chunks, declared, kind = 'RIFF') {
  const bytes = Buffer.concat([Buffer.alloc(12), ...chunks]);
  bytes.write(kind);
  bytes.writeUInt32LE(declared ?? bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  return bytes;
}

const fmt = chunk('fmt ', pcmFormat);
const extra = chunk('JUNK', Buffer.from('odd'));
const canonical = riff([fmt, extra, chunk('data', samples)]);
const streamed = riff([fmt, extra, chunk('data', samples, unknown)], unknown);

function rf64(unseekable) {
  const ds64 = chunk('ds64', Buffer.alloc(28));
  const bytes = riff([ds64, fmt, extra, chunk('data', samples, unknown)], unknown, 'RF64');
  if (!unseekable) {
    bytes.writeBigUInt64LE(BigInt(bytes.length - 8), 20);
    bytes.writeBigUInt64LE(BigInt(samples.length), 28);
    bytes.writeBigUInt64LE(BigInt(samples.length / 2), 36);
  }
  return bytes;
}

function synthesize(bytes, chat = false, mime = 'audio/wav') {
  const fetchImpl = async () => chat ? Response.json({
    choices: [{ finish_reason: 'stop', message: { audio: { data: bytes.toString('base64') } } }],
  }) : new Response(bytes, { headers: { 'Content-Type': mime } });
  const openai = createOpenAISpeech({ key: () => 'fixture-only', fetchImpl });
  return openai.synthesize({ text: '测试', model: chat ? 'gpt-audio-1.5' : 'gpt-4o-mini-tts' });
}

test('OpenAI speech binary and chat base64 WAV fix streaming lengths without touching sample bytes', async () => {
  for (const chat of [false, true]) {
    assert.deepEqual(await synthesize(streamed, chat), canonical);
    assert.deepEqual(await synthesize(canonical, chat), canonical);
  }
  const finiteData = riff([fmt, extra, chunk('data', samples)], unknown);
  assert.deepEqual(await synthesize(finiteData, false, 'application/octet-stream'), canonical);
  const fmt24 = chunk('fmt ', Buffer.from('feff0100007d0000007701000300180016001800040000000100000000001000800000aa00389b71', 'hex'));
  const odd = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const unpadded = riff([fmt24, chunk('data', odd, unknown)], unknown).subarray(0, -1);
  assert.deepEqual(await synthesize(unpadded), riff([fmt24, chunk('data', odd)]));
});

test('small RF64 WAVs with declared or streaming ds64 sizes become playable RIFF files', async () => {
  for (const unseekable of [false, true]) {
    const bytes = rf64(unseekable);
    const fixed = await synthesize(bytes);
    const expected = Buffer.from(bytes);
    expected.write('RIFF', 0);
    expected.write('JUNK', 12);
    expected.writeUInt32LE(bytes.length - 8, 4);
    expected.writeUInt32LE(samples.length, bytes.indexOf('data') + 4);
    assert.deepEqual(fixed, expected);
  }
});

test('invalid and partial WAVs are rejected even with a WAV MIME or streaming markers', async () => {
  const mismatch = rf64(false);
  mismatch.writeBigUInt64LE(99n, 28);
  const brokenFormat = Buffer.from(pcmFormat);
  brokenFormat.writeUInt16LE(4, 12);
  const unrecognized = Buffer.from(pcmFormat);
  unrecognized.writeUInt16LE(17, 0);
  for (const bytes of [
    samples, Buffer.from('{"error":"upstream returned JSON"}'), canonical.subarray(0, -2),
    streamed.subarray(0, -1), mismatch, riff([fmt, chunk('data', Buffer.alloc(0), unknown)], unknown),
    riff([fmt, chunk('data', samples.subarray(0, 3))]),
    riff([chunk('fmt ', brokenFormat), chunk('data', samples)]),
    riff([chunk('fmt ', brokenFormat), chunk('data', samples, unknown)], unknown),
    riff([chunk('fmt ', unrecognized), chunk('data', samples, unknown)], unknown),
    riff([fmt, chunk('data', samples, samples.length + 4)], unknown),
    riff([chunk('JUNK', Buffer.from('abc'), unknown), fmt, chunk('data', samples)], unknown),
  ]) await assert.rejects(synthesize(bytes), { status: 502 });
});
