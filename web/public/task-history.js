import { browserProof, protectedFetch } from './session.js';

const engines = { qwen: 'Qwen', whisper: 'Whisper', openai: 'OpenAI' };
const kinds = { tts: '文字转语音', stt: '语音转文字' };
const states = { completed: '已完成', failed: '失败', cancelled: '已取消' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text != null) result.textContent = text;
  return result;
}

function action(label, className, onClick) {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function status(target, message = '', error = false) {
  target.textContent = message;
  target.classList.toggle('error', error);
}

function explain(error) {
  if (error.name === 'TimeoutError') return '请求超时，请重试。';
  if (error instanceof TypeError) return '无法连接本机服务，请重试。';
  return error.message;
}

function sizeText(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

export function mountTaskHistory(root, kind) {
  root.innerHTML = `
    <header class="history-panel-head">
      ${kind ? '<h2>任务历史</h2>' : ''}
      <button data-part="history-refresh" class="secondary" type="button">刷新</button>
    </header>
    <p data-part="history-status" role="status"></p>
    <button data-part="history-retry" class="secondary" type="button" hidden>重试</button>
    <p data-part="history-empty" class="history-empty" hidden>暂无任务记录</p>
    <ul data-part="history-list" class="task-list" aria-label="我的转换记录"></ul>
    <nav class="history-pagination" data-part="history-pagination" aria-label="任务历史分页" hidden>
      <button data-part="history-previous" class="secondary" type="button">上一页</button>
      <span data-part="history-page" role="status"></span>
      <button data-part="history-next" class="secondary" type="button">下一页</button>
    </nav>
    <dialog class="history-delete-dialog" data-part="delete-dialog" aria-label="删除这条任务记录？">
      <h2>删除这条任务记录？</h2>
      <p data-part="delete-description"></p>
      <p data-part="delete-error" role="alert"></p>
      <div><button data-part="delete-cancel" type="button" class="secondary" autofocus>取消</button><button data-part="delete-confirm" type="button" class="primary">确认删除</button></div>
    </dialog>`;

  const el = name => root.querySelector('[data-part="' + name + '"]');
  const requests = new Set();
  const downloadURLs = new Set();
  let pages = [null];
  let pageIndex = -1;
  let retryPage = 0;
  let nextCursor = null;
  let loading = false;
  let pendingPage;
  let stale = false;
  let locked = false;
  let preview;
  let deletion;

  function releaseDownload(url) {
    if (downloadURLs.delete(url)) URL.revokeObjectURL(url);
  }

  function closePreview() {
    if (!preview) return;
    const previous = preview;
    preview = null;
    previous.controller.abort();
    if (previous.audio) {
      previous.audio.pause();
      previous.audio.removeAttribute('src');
      previous.audio.load();
    }
    if (previous.url) URL.revokeObjectURL(previous.url);
    previous.holder.replaceChildren();
    previous.holder.hidden = true;
    previous.button.textContent = '试听';
    previous.button.setAttribute('aria-expanded', 'false');
  }

  function clearPrivateView() {
    locked = true;
    for (const controller of requests) controller.abort();
    closePreview();
    for (const url of downloadURLs) releaseDownload(url);
    if (el('delete-dialog').open) el('delete-dialog').close();
    el('delete-description').textContent = '';
    deletion = null;
    el('history-list').replaceChildren();
    status(el('history-status'));
  }

  async function request(path, method = 'GET', asBlob = false, controller = new AbortController()) {
    const originalProof = browserProof();
    const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), asBlob ? 120000 : 20000);
    requests.add(controller);
    try {
      const response = await protectedFetch(path, { method, cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.error || '操作失败，请重试。');
      }
      const result = asBlob ? await response.blob() : response.status === 204 ? null : await response.json();
      if (!locked && originalProof !== browserProof()) {
        clearPrivateView();
        location.reload();
      }
      if (locked || controller.signal.aborted) throw new DOMException('操作已取消', 'AbortError');
      return result;
    } finally {
      requests.delete(controller);
      clearTimeout(timer);
    }
  }

  function resultPath(task) {
    return '/api/history/' + encodeURIComponent(task.id) + '/download';
  }

  async function play(task, button, holder, feedback) {
    const wasOpen = preview?.task.id === task.id;
    closePreview();
    if (wasOpen || locked) return;
    const current = { task, button, holder, controller: new AbortController() };
    preview = current;
    button.textContent = '取消试听';
    button.setAttribute('aria-expanded', 'true');
    status(feedback, '正在读取音频…');
    try {
      const blob = await request(resultPath(task), 'GET', true, current.controller);
      if (preview !== current) return;
      current.url = URL.createObjectURL(blob);
      const audio = element('audio');
      current.audio = audio;
      audio.controls = true;
      audio.setAttribute('aria-label', '试听 · ' + task.label);
      audio.addEventListener('error', () => {
        if (preview === current) status(feedback, '当前浏览器无法播放此格式，可下载原文件试听。', true);
      });
      audio.src = current.url;
      holder.replaceChildren(audio);
      holder.hidden = false;
      button.textContent = '收起试听';
      status(feedback);
      await audio.play().catch(() => { /* 原生播放控件支持手动开始。 */ });
    } catch (error) {
      if (preview === current) {
        closePreview();
        if (!locked) status(feedback, explain(error), true);
      }
    } finally {
      if (preview !== current && feedback.textContent === '正在读取音频…') status(feedback);
    }
  }

  async function download(task, button, feedback) {
    if (locked || button.disabled) return;
    button.disabled = true;
    status(feedback, '正在准备下载…');
    try {
      const blob = await request(resultPath(task), 'GET', true);
      const url = URL.createObjectURL(blob);
      downloadURLs.add(url);
      const link = element('a');
      link.href = url;
      const safeId = String(task.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      link.download = 'voice-studio-' + task.kind + '-' + safeId + '.' + task.format;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => releaseDownload(url), 60000);
      status(feedback, '下载已开始。');
    } catch (error) {
      if (!locked) status(feedback, explain(error), true);
    } finally {
      button.disabled = false;
    }
  }

  function confirmDelete(task) {
    deletion = task;
    el('delete-description').textContent = '将删除「' + task.label + '」的记录' +
      (task.status === 'completed' ? '及其结果文件。' : '。') + '此操作无法撤销。';
    status(el('delete-error'));
    el('delete-dialog').showModal();
  }

  async function removeTask() {
    const task = deletion;
    if (!task || locked || el('delete-confirm').disabled) return;
    el('delete-confirm').disabled = true;
    el('delete-cancel').disabled = true;
    try {
      await request('/api/history/' + encodeURIComponent(task.id), 'DELETE');
      if (preview?.task.id === task.id) closePreview();
      const row = [...el('history-list').children].find(item => item.dataset.taskId === task.id);
      row?.remove();
      el('delete-dialog').close();
      el('history-refresh').focus();
      await load(Math.max(0, pageIndex), true);
    } catch (error) {
      if (!locked) status(el('delete-error'), explain(error), true);
    } finally {
      el('delete-confirm').disabled = false;
      el('delete-cancel').disabled = false;
    }
  }

  function taskRow(task) {
    const row = element('li', 'task-row');
    row.dataset.taskId = task.id;
    const info = element('div');
    const meta = element('div', 'task-meta');
    if (!kind) meta.append(element('span', '', kinds[task.kind]));
    meta.append(element('span', '', engines[task.engine]));
    const date = new Date(task.createdAt);
    const time = element('time', '', dateFormat.format(date));
    time.dateTime = task.createdAt;
    meta.append(time);
    if (task.status === 'completed') meta.append(element('span', '', task.format.toUpperCase() + ' · ' + sizeText(task.bytes)));
    info.append(element(kind ? 'h3' : 'h2', 'task-name', task.label), meta);
    const state = element('span', 'task-state ' + task.status, states[task.status]);
    const actions = element('div', 'task-actions');
    const holder = element('div', 'task-preview');
    const feedback = element('p', 'task-feedback');
    feedback.setAttribute('role', 'status');
    holder.hidden = true;
    if (task.status === 'completed') {
      if (task.kind === 'tts') {
        const listen = action('试听', 'secondary', () => void play(task, listen, holder, feedback));
        listen.setAttribute('aria-expanded', 'false');
        actions.append(listen);
      }
      const save = action('下载 ' + task.format.toUpperCase(), 'secondary', () => void download(task, save, feedback));
      actions.append(save);
    }
    actions.append(action('删除', 'task-delete', () => confirmDelete(task)));
    row.append(info, state, actions, holder, feedback);
    return row;
  }

  function syncPagination() {
    el('history-pagination').hidden = pageIndex <= 0 && !nextCursor;
    el('history-previous').disabled = loading || pageIndex <= 0;
    el('history-next').disabled = loading || !nextCursor;
    el('history-page').textContent = '第 ' + (pageIndex + 1) + ' 页';
  }

  async function load(target = 0, queue = false) {
    if (locked) return;
    if (loading) {
      if (queue || target === 0) pendingPage = Math.min(target, pendingPage ?? target);
      return;
    }
    loading = true;
    stale = false;
    el('history-refresh').disabled = true;
    el('history-retry').hidden = true;
    el('history-list').setAttribute('aria-busy', 'true');
    status(el('history-status'), '正在读取任务历史…');
    syncPagination();
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (pages[target]) params.set('cursor', pages[target]);
    let previous = false;
    try {
      const query = params.size ? '?' + params : '';
      const page = await request('/api/history' + query);
      if (!page.tasks.length && target > 0) {
        previous = true;
        return;
      }
      closePreview();
      el('history-list').replaceChildren(...page.tasks.map(taskRow));
      pageIndex = target;
      pages = pages.slice(0, target + 1);
      nextCursor = page.nextCursor;
      if (nextCursor) pages.push(nextCursor);
      el('history-empty').hidden = page.tasks.length !== 0;
      status(el('history-status'));
    } catch (error) {
      if (locked) return;
      retryPage = target;
      status(el('history-status'), explain(error), true);
      el('history-retry').hidden = false;
    } finally {
      loading = false;
      el('history-refresh').disabled = false;
      el('history-list').removeAttribute('aria-busy');
      syncPagination();
      if (pendingPage !== undefined) {
        const queued = pendingPage;
        pendingPage = undefined;
        void load(queued);
      } else if (previous) void load(target - 1);
    }
  }

  el('history-refresh').addEventListener('click', () => void load());
  el('history-previous').addEventListener('click', () => void load(pageIndex - 1));
  el('history-next').addEventListener('click', () => void load(pageIndex + 1));
  el('history-retry').addEventListener('click', () => void load(retryPage));
  el('delete-confirm').addEventListener('click', () => void removeTask());
  el('delete-cancel').addEventListener('click', () => el('delete-dialog').close());
  el('delete-dialog').addEventListener('cancel', event => {
    if (el('delete-confirm').disabled) event.preventDefault();
  });
  el('delete-dialog').addEventListener('close', () => { deletion = null; });
  return {
    activate() { if ((pageIndex < 0 || stale) && !loading) void load(); },
    invalidate() { stale = true; },
    pause: closePreview,
    refresh: load,
    clear: clearPrivateView,
  };
}
