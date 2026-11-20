import assert from 'node:assert/strict';
import { createWorkspaceServer } from '../server.mjs';

export async function sessionHeaders(response) {
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const { browserProof } = await response.clone().json();
  assert.match(browserProof, /^[A-Za-z0-9_-]{21}$/);
  return { Cookie: cookie, 'X-Voice-Proof': browserProof };
}

// Use the real first-owner and browser session paths against isolated databases.
export async function testServer(t, providers = {}) {
  const setupCode = 'isolated-fixture-setup-code';
  const server = createWorkspaceServer({ database: ':memory:', setupCode, ...providers });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(origin + '/api/auth/bootstrap', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'local-fixture-password', setupCode }),
  });
  assert.equal(response.status, 200);
  return { origin, headers: await sessionHeaders(response) };
}
