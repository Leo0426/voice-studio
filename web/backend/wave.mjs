const unknownSize = 0xffffffff;
const subtypeTail = Buffer.from('00001000800000aa00389b71', 'hex');

// Zero denotes a compressed format whose payload requires an explicit length.
function sampleFrameSize(fmt) {
  let tag = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const frame = fmt.readUInt16LE(12);
  const bits = fmt.readUInt16LE(14);
  if (!tag || !channels || !rate || !frame) return;
  if (tag === 0xfffe) {
    if (fmt.length < 40 || fmt.readUInt16LE(16) < 22) return;
    if (!fmt.subarray(28, 40).equals(subtypeTail)) return 0;
    tag = fmt.readUInt32LE(24);
  }
  if (tag !== 1 && tag !== 3) return 0;
  if (!bits || (tag === 3 && bits !== 32 && bits !== 64)) return;
  if (frame !== channels * Math.ceil(bits / 8) || fmt.readUInt32LE(8) !== rate * frame) return;
  return frame;
}

function readRF64(wav) {
  if (wav.length < 48 || wav.toString('latin1', 12, 16) !== 'ds64') return;
  const size = wav.readUInt32LE(16);
  if (size < 28 || size + 20 > wav.length || wav.readUInt32LE(44) !== 0) return;
  const riff = wav.readBigUInt64LE(20);
  const data = wav.readBigUInt64LE(28);
  const frames = wav.readBigUInt64LE(36);
  if (riff === 0n && data === 0n && frames === 0n) return {};
  if (riff !== BigInt(wav.length - 8) || !data || data > riff || frames > data) return;
  return { data: Number(data), frames: Number(frames) };
}

// Patch completed HTTP responses only after validating chunks and the full sample payload.
export function normalizeWave(wav) {
  if (wav.length < 44 || wav.length - 8 >= unknownSize || wav.toString('latin1', 8, 12) !== 'WAVE') return;
  const kind = wav.toString('latin1', 0, 4);
  if (kind !== 'RIFF' && kind !== 'RF64') return;
  const riffSize = wav.readUInt32LE(4);
  let rf64;
  if (kind === 'RF64') {
    rf64 = readRF64(wav);
    if (riffSize !== unknownSize || !rf64) return;
  }
  const end = riffSize === unknownSize ? wav.length : 8 + riffSize;
  if (end > wav.length) return;
  let offset = 12, frame, dataOffset, dataSize, patchData = false, addPad = false;
  while (offset + 8 <= end) {
    const id = wav.toString('latin1', offset, offset + 4);
    let size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'data') {
      if (dataOffset !== undefined || frame === undefined) return;
      dataOffset = offset + 4;
      patchData = size === unknownSize;
      if (patchData) {
        size = rf64?.data ?? end - start;
        if (!rf64?.data) {
          if (!frame) return;
          // A RIFF pad byte lies outside the final sample frame of an odd-sized chunk.
          if (size % frame && !(size % 2) && wav[end - 1] === 0 && (size - 1) % frame === 0) size--;
          // Non-seekable FFmpeg output can omit the final pad on an otherwise complete frame.
          addPad = riffSize === unknownSize && size % 2 === 1 && size === end - start;
        }
      }
      if (!size || (rf64?.data && size !== rf64.data)) return;
      if (frame && (size % frame || (rf64?.frames && rf64.frames !== size / frame))) return;
      dataSize = size;
    }
    if (size === unknownSize || start + size > end) return;
    if (id === 'fmt ') {
      if (frame !== undefined || size < 16) return;
      frame = sampleFrameSize(wav.subarray(start, start + size));
      if (frame === undefined) return;
    }
    offset = start + size + size % 2;
  }
  if (offset !== end + Number(addPad) || dataOffset === undefined) return;
  if (addPad) wav = Buffer.concat([wav, Buffer.alloc(1)]);
  if (rf64) { wav.write('RIFF', 0); wav.write('JUNK', 12); }
  if (riffSize === unknownSize) wav.writeUInt32LE(wav.length - 8, 4);
  if (patchData) wav.writeUInt32LE(dataSize, dataOffset);
  return wav;
}
