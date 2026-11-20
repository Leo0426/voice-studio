const el = id => document.getElementById(id);
const audio = el('qwen-audio');
const track = el('player-track');
const toggle = el('player-toggle');
const seek = el('player-seek');
const wave = el('wave');
const playedWave = el('wave-played');
let sourceURL, peaks, decodedDuration = 0, frame = 0;

function duration() {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : decodedDuration;
}

function clock(value, tenths = false) {
  const ticks = Math.max(0, Math.floor(value * 10 + 1e-6));
  const seconds = Math.floor(ticks / 10);
  const minutes = Math.floor(seconds / 60);
  const text = minutes + ':' + String(seconds % 60).padStart(2, '0');
  return tenths ? text + '.' + ticks % 10 : text;
}

function drawRuler() {
  const length = duration(), width = track.clientWidth;
  const ruler = el('player-ruler');
  const display = el('player-display');
  ruler.hidden = !length;
  ruler.replaceChildren();
  if (!length || !width) {
    display.style.removeProperty('--division');
    display.style.removeProperty('--subdivision');
    return;
  }
  const minStep = length / Math.max(2, Math.floor(width / 62));
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  const step = steps.find(s => s >= minStep) ?? Math.ceil(minStep / 3600) * 3600;
  const division = 100 * step / length;
  display.style.setProperty('--division', division + '%');
  display.style.setProperty('--subdivision', division / 5 + '%');
  for (let i = 0; i * step < length; i++) {
    const left = i * step / length;
    if (i && (1 - left) * width < 22) break;
    const label = document.createElement('span');
    label.style.left = 100 * left + '%';
    label.textContent = clock(i * step, step < 1);
    ruler.append(label);
  }
}

function updatePosition() {
  const length = duration();
  const current = Math.min(audio.currentTime || 0, length);
  const position = length ? current / length : 0;
  seek.value = String(current);
  track.style.setProperty('--progress', (100 * position) + '%');
  const time = length ? clock(current, length < 10) : '–:––';
  if (el('player-time').textContent !== time) el('player-time').textContent = time;
  const spokenTime = length ? time + ' / ' + clock(length, length < 10) : '暂无音频';
  if (seek.getAttribute('aria-valuetext') !== spokenTime) seek.setAttribute('aria-valuetext', spokenTime);
}

function updateDuration() {
  const length = duration();
  seek.max = String(length || 1);
  seek.disabled = !sourceURL || !length || audio.readyState < 1 || Boolean(audio.error);
  track.classList.toggle('seekable', !seek.disabled);
  el('player-duration').textContent = length ? clock(length, length < 10) : '–:––';
  drawRuler();
  updatePosition();
}

function updateToggle() {
  const playing = !audio.paused && !audio.ended;
  toggle.classList.toggle('playing', playing);
  const label = playing ? '暂停播放' : '播放音频';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

function animate() {
  updatePosition();
  frame = audio.paused || audio.ended ? 0 : requestAnimationFrame(animate);
}

function stopAnimation() {
  cancelAnimationFrame(frame);
  frame = 0;
  updatePosition();
}

function drawWaveform() {
  const width = track.clientWidth, height = track.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const count = Math.max(1, Math.floor(width / 4));
  for (const [canvas, color] of [[wave, '#aeb8b4'], [playedWave, '#fac47a']]) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx || !peaks) continue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * peaks.length / count);
      const end = Math.min(peaks.length, Math.max(start + 1, Math.floor((i + 1) * peaks.length / count)));
      let peak = 0;
      for (let j = start; j < end; j++) peak = Math.max(peak, peaks[j]);
      const barHeight = Math.max(2, peak * (height - 4));
      ctx.fillRect(i * width / count, (height - barHeight) / 2, Math.min(2.5, width / count), barHeight);
    }
  }
  track.classList.toggle('has-wave', Boolean(peaks));
}

async function readWaveform(blob, url) {
  try {
    const decoder = new OfflineAudioContext(1, 1, 16000);
    const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
    if (sourceURL !== url) return;
    const bins = new Float32Array(Math.min(1024, buffer.length));
    let max = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const samples = buffer.getChannelData(c);
      for (let i = 0; i < bins.length; i++) {
        const start = Math.floor(i * samples.length / bins.length);
        const end = Math.floor((i + 1) * samples.length / bins.length);
        let peak = bins[i];
        for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(samples[j]));
        bins[i] = peak;
        max = Math.max(max, peak);
      }
    }
    if (max) for (let i = 0; i < bins.length; i++) bins[i] /= max;
    peaks = bins;
    decodedDuration = buffer.duration;
    drawWaveform();
    updateDuration();
  } catch {
    if (sourceURL === url && !audio.error) el('player-notice').textContent = '波形预览不可用，仍可使用进度条。';
  }
}

export function previewFormat(format) {
  if (!sourceURL) el('output-format').textContent = format.toUpperCase();
}

export function showAudio(blob, format, origin) {
  const previous = sourceURL;
  audio.pause();
  sourceURL = URL.createObjectURL(blob);
  peaks = undefined;
  decodedDuration = 0;
  track.classList.remove('has-wave');
  drawWaveform();
  audio.src = sourceURL;
  audio.load();
  if (previous) URL.revokeObjectURL(previous);
  el('output-format').textContent = format.toUpperCase();
  el('download-audio').href = sourceURL;
  el('download-audio').download = 'voice-studio.' + format;
  el('download-title').textContent = '下载 ' + format.toUpperCase() + ' 音频';
  el('audio-origin').textContent = origin;
  el('audio-empty').hidden = true;
  el('audio-result').hidden = false;
  el('player-notice').textContent = '';
  toggle.disabled = false;
  updateToggle();
  updateDuration();
  void readWaveform(blob, sourceURL);
}

toggle.addEventListener('click', async () => {
  if (!audio.paused && !audio.ended) { audio.pause(); return; }
  const currentURL = sourceURL;
  try {
    if (audio.ended) audio.currentTime = 0;
    await audio.play();
  } catch (error) {
    if (currentURL === sourceURL && error.name !== 'AbortError') {
      el('player-notice').textContent = '这段音频暂时无法播放，可以下载后试听。';
    }
  }
});

function seekTo(time) {
  if (seek.disabled) return;
  audio.currentTime = Math.max(0, Math.min(duration(), time));
  updatePosition();
}

seek.addEventListener('input', () => seekTo(Number(seek.value)));
seek.addEventListener('keydown', event => {
  const length = duration();
  const step = Math.min(5, length / 10);
  const current = audio.currentTime;
  const targets = {
    ArrowLeft: current - step, ArrowRight: current + step, ArrowDown: current - step, ArrowUp: current + step,
    Home: 0, End: length, PageDown: current - length / 10, PageUp: current + length / 10,
  };
  if (!Object.hasOwn(targets, event.key)) return;
  event.preventDefault();
  seekTo(targets[event.key]);
});

audio.addEventListener('loadedmetadata', updateDuration);
audio.addEventListener('durationchange', updateDuration);
audio.addEventListener('timeupdate', updatePosition);
audio.addEventListener('play', updateToggle);
audio.addEventListener('playing', () => { if (!frame) animate(); });
audio.addEventListener('waiting', stopAnimation);
for (const name of ['pause', 'ended']) {
  audio.addEventListener(name, () => { stopAnimation(); updateToggle(); });
}
audio.addEventListener('error', () => {
  if (!sourceURL || !audio.error) return;
  stopAnimation();
  updateToggle();
  toggle.disabled = true;
  updateDuration();
  el('player-notice').textContent = '当前浏览器无法试听这段音频，可以下载文件。';
});
new ResizeObserver(() => { drawWaveform(); drawRuler(); }).observe(track);
window.addEventListener('pagehide', event => {
  audio.pause();
  if (sourceURL && !event.persisted) URL.revokeObjectURL(sourceURL);
});
