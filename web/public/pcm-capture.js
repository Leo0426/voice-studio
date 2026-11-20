// 采集设备采样率的单声道 PCM，输出端保持静音。
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(4096);
    this.used = 0;
    this.running = true;
    this.port.onmessage = ({ data }) => {
      if (data !== 'finish') return;
      this.running = false;
      this.flush();
      this.port.postMessage('finished');
    };
  }
  flush() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage(samples, [samples.buffer]);
    this.used = 0;
  }
  process(inputs) {
    if (!this.running) return false;
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const value of channel) {
        this.buffer[this.used++] = Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
        if (this.used === this.buffer.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
