let session;
const signalName = 'voice-studio.accounts.changed';
const proofName = 'voice-studio.session-proof';

export function browserProof() {
  try { return localStorage.getItem(proofName); } catch { return null; }
}

export function saveBrowserProof(value) {
  if (typeof value !== 'string' || !value) throw new Error('登录服务未返回完整凭据，请重新登录。');
  try { localStorage.setItem(proofName, value); }
  catch { throw new Error('无法保存登录状态，请允许此站点使用本机存储后重试。'); }
}

export function forgetBrowserProof(previous) {
  if (previous && browserProof() === previous) localStorage.removeItem(proofName);
}

function proofHeaders(initial) {
  const headers = new Headers(initial);
  const proof = browserProof();
  if (proof) headers.set('X-Voice-Proof', proof);
  return headers;
}

export function can(permission) {
  return Boolean(session?.user?.active && session.permissions.includes(permission));
}

export function conversionReturn(value) {
  try {
    const url = new URL(value || '/', location.origin);
    if (url.origin !== location.origin) return '/';
    if (url.pathname === '/history.html') return '/history.html';
    if (!['/', '/index.html'].includes(url.pathname)) return '/';
    const query = url.searchParams.get('engine') === 'openai' ? '?engine=openai' : '';
    const hash = ['#tts', '#stt', '#openai-key', '#voice-create'].includes(url.hash) ? url.hash : '';
    return '/' + query + hash;
  } catch { return '/'; }
}

export function accountAddress() {
  return '/account.html?' + new URLSearchParams({ returnTo: conversionReturn(location.href) });
}

export async function readSession() {
  const response = await fetch('/api/auth/session', { cache: 'no-store', headers: proofHeaders(), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('无法读取登录状态，请检查本机服务。');
  const next = await response.json();
  if (typeof next.needsSetup !== 'boolean' || !Array.isArray(next.permissions)) throw new Error('登录服务返回了无效状态。');
  return next;
}

export async function protectedFetch(url, options = {}) {
  const headers = proofHeaders(options.headers);
  if (session?.user) {
    headers.set('X-Voice-Actor', session.user.id);
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 409 && response.headers.get('X-Voice-Account-Changed') === '1') {
    window.dispatchEvent(new Event('account-replaced'));
  }
  if (response.status === 401 || response.status === 403) {
    window.dispatchEvent(new CustomEvent('account-access-check', { detail: response.status }));
  }
  return response;
}

export function announceChange() {
  try { localStorage.setItem(signalName, crypto.randomUUID()); } catch { /* Polling also checks the session. */ }
  window.webkit?.messageHandlers?.voiceStudioSession?.postMessage('refresh');
}

function fingerprint(data) {
  return JSON.stringify([data.needsSetup, data.user?.id, data.user?.active, [...(data.user?.roleIds || [])].sort(), [...data.permissions].sort()]);
}

export function watchSession(initial, onChange) {
  session = initial;
  let checking = false, pending = false;
  async function check() {
    if (checking) { pending = true; return; }
    checking = true;
    try {
      const next = await readSession();
      if (fingerprint(next) !== fingerprint(session)) {
        session = next;
        onChange(next);
      }
    } catch { /* A temporary connection failure does not identify a new session. */ }
    finally {
      checking = false;
      if (pending) { pending = false; void check(); }
    }
  }
  window.addEventListener('storage', event => {
    if ([signalName, proofName, null].includes(event.key)) void check();
  });
  window.addEventListener('account-replaced', () => onChange());
  window.addEventListener('focus', check);
  window.addEventListener('account-access-check', event => {
    if (event.detail === 401 && session?.user) onChange();
    else void check();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
  setInterval(() => { if (!document.hidden) void check(); }, 12000);
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  return check;
}
