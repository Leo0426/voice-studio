import { accountAddress, can, readSession, watchSession } from './session.js';
import { mountTaskHistory } from './task-history.js';

const histories = Object.fromEntries(['tts', 'stt'].map(kind =>
  [kind, mountTaskHistory(document.getElementById(kind + '-history'), kind)]));

function lock() {
  document.body.classList.add('session-pending');
  Object.values(histories).forEach(history => history.clear());
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  document.querySelectorAll('textarea,input:not([type=radio]):not([type=checkbox]):not([type=range])').forEach(input => { input.value = ''; });
  document.getElementById('qwen-audio').pause();
  document.getElementById('voice-demo-audio').pause();
}

async function start() {
  const status = document.getElementById('session-status');
  const retry = document.getElementById('session-retry');
  retry.hidden = true;
  status.textContent = '正在检查登录状态…';
  try {
    const session = await readSession();
    if (!session.user?.active) { lock(); location.replace(accountAddress()); return; }
    watchSession(session, next => {
      lock();
      if (next?.user?.active) location.reload();
      else location.replace(accountAddress());
    });
    const account = document.getElementById('workspace-account');
    account.textContent = session.user.username;
    account.setAttribute('aria-label', '账号中心 · ' + session.user.username);
    account.title = '账号中心 · ' + session.user.username;
    const updateAccountLink = () => { account.href = accountAddress(); };
    updateAccountLink();
    window.addEventListener('hashchange', updateAccountLink);
    const voice = document.getElementById('create-custom-voice');
    voice.hidden = !can('voices.manage');
    document.getElementById('workspace-voice').hidden = !can('voices.manage') || can('tts.openai');
    await import('./app.js');
    if (can('voices.manage')) await import('./voice-enrollment.js');
    document.body.classList.remove('session-pending');
    function showHistory() {
      for (const [kind, history] of Object.entries(histories)) {
        if (document.getElementById(kind + '-view').hidden) history.pause();
        else history.activate();
      }
    }
    showHistory();
    window.addEventListener('hashchange', showHistory);
    document.addEventListener('conversion-settled', event => {
      const { kind } = event.detail;
      const history = histories[kind];
      if (document.getElementById(kind + '-view').hidden) history.invalidate();
      else void history.refresh();
    });
    window.addEventListener('storage', event => {
      if (event.key === 'voice-studio.session-proof' || event.key === null) {
        lock();
        location.reload();
      }
    });
    window.addEventListener('pagehide', event => {
      if (event.persisted) lock();
    });
  } catch {
    status.textContent = '工作台暂时无法打开，请检查本机服务。';
    retry.hidden = false;
  }
}
document.getElementById('session-retry').addEventListener('click', () => location.reload());
void start();
