export const maxBytes = 50 * 1024 * 1024;

function wav(chunks, count, sampleRate) {
  const header = new DataView(new ArrayBuffer(44));
  function label(at, text) {
    for (let i = 0; i < text.length; i++) header.setUint8(at + i, text.charCodeAt(i));
  }
  label(0, 'RIFF');
  header.setUint32(4, 36 + count * 2, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  label(36, 'data');
  header.setUint32(40, count * 2, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}

export class MicrophoneRecording {
  constructor(onFull, onError, byteLimit = maxBytes) {
    this.onFull = onFull;
    this.onError = onError;
    this.maxSamples = Math.floor((byteLimit - 44) / 2);
    this.chunks = [];
    this.count = 0;
    this.closed = false;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
      throw new Error('此浏览器无法使用本地麦克风，请选择音频文件或在支持录音的浏览器中打开。');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    const context = new AudioContext();
    this.context = context;
    await context.audioWorklet.addModule('/pcm-capture.js');
    if (this.closed) return;
    const node = new AudioWorkletNode(context, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
    this.node = node;
    node.port.onmessage = ({ data }) => {
      if (this.closed) return;
      if (data === 'finished') { this.finishAck?.(); return; }
      const length = Math.min(data.length, this.maxSamples - this.count);
      if (!length) return;
      this.chunks.push(data.subarray(0, length));
      this.count += length;
      if (this.count === this.maxSamples) this.onFull();
    };
    node.onprocessorerror = () => this.onError('录音处理已中断，请重新录音。');
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (!this.closed && !this.finishAck) this.onError('麦克风连接已断开，请重新录音。');
    });
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(node);
    node.connect(context.destination);
    await context.resume();
  }

  async finish() {
    if (!this.node || this.closed) throw new Error('录音尚未开始。');
    const rate = this.context.sampleRate;
    try {
      await new Promise((resolve, reject) => {
        this.finishAck = resolve;
        this.flushTimer = setTimeout(() => reject(new Error('录音未能保存，请重试。')), 2000);
        this.node.port.postMessage('finish');
        this.stream.getTracks().forEach(track => track.stop());
      });
      if (this.closed || !this.count) throw new Error('没有录到声音，请重试。');
      return wav(this.chunks, this.count, rate);
    } finally {
      this.close();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.finishAck?.();
    clearTimeout(this.flushTimer);
    this.stream?.getTracks().forEach(track => track.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.port.close();
    if (this.context) void this.context.close().catch(() => {});
    this.chunks = [];
  }
}
