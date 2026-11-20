import { accountAddress, readSession, watchSession } from './session.js';
import { mountTaskHistory } from './task-history.js';

const panel = mountTaskHistory(document.getElementById('history-panel'));

function lock() {
  document.body.classList.add('session-pending');
  document.getElementById('history-owner').textContent = '';
  panel.clear();
}

window.addEventListener('pagehide', lock);
window.addEventListener('storage', event => {
  if (event.key === 'voice-studio.session-proof' || event.key === null) {
    lock();
    location.reload();
  }
});
document.getElementById('session-retry').addEventListener('click', () => location.reload());

async function start() {
  try {
    const session = await readSession();
    if (!session.user?.active) { location.replace(accountAddress()); return; }
    watchSession(session, next => {
      lock();
      if (next?.user?.active) location.reload();
      else location.replace(accountAddress());
    });
    document.getElementById('history-owner').textContent = '当前账号 · ' + session.user.username;
    document.body.classList.remove('session-pending');
    panel.activate();
  } catch (error) {
    document.getElementById('session-status').textContent = error.message;
    document.getElementById('session-retry').hidden = false;
  }
}
void start();
