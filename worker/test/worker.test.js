// Run with:  node --test   (from the repo root or from worker/)
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const ENV = {
  CLICKUP_CLIENT_ID: 'client-id',
  CLICKUP_CLIENT_SECRET: 'client-secret',
  ALLOWED_ORIGINS: 'https://easyseebv.github.io, http://localhost:8765/',
};
const ORIGIN = 'https://easyseebv.github.io';

function post(body, origin = ORIGIN) {
  return new Request('https://auth.example.workers.dev/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function withFetchStub(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}

test('OPTIONS preflight answers 204 with CORS headers for an allowed origin', async () => {
  const res = await worker.fetch(new Request('https://x/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
});

test('rejects non-POST, foreign origins and bad bodies', async () => {
  const get = await worker.fetch(new Request('https://x/', { headers: { Origin: ORIGIN } }), ENV);
  assert.equal(get.status, 405);

  const foreign = await worker.fetch(post({ code: 'ABCDEF' }, 'https://evil.example'), ENV);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), ORIGIN); // never echoes the foreign origin

  const notJson = await worker.fetch(post('not json'), ENV);
  assert.equal(notJson.status, 400);

  const noCode = await worker.fetch(post({}), ENV);
  assert.equal(noCode.status, 400);

  const weirdCode = await worker.fetch(post({ code: 'a b<script>' }), ENV);
  assert.equal(weirdCode.status, 400);
});

test('exchanges the code with ClickUp using the secret and returns only the access token', async () => {
  let seen = null;
  await withFetchStub(async (url, init) => {
    seen = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ access_token: 'tok_123', other: 'ignored' }), { status: 200 });
  }, async () => {
    const res = await worker.fetch(post({ code: 'CODE_abc-1' }, 'http://localhost:8765'), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { access_token: 'tok_123' });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8765');
  });
  assert.equal(seen.url, 'https://api.clickup.com/api/v2/oauth/token');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(seen.body, { client_id: 'client-id', client_secret: 'client-secret', code: 'CODE_abc-1' });
});

test('passes ClickUp errors through without leaking the secret', async () => {
  await withFetchStub(async () => new Response(JSON.stringify({ err: 'Invalid client credentials', ECODE: 'OAUTH_011' }), { status: 401 }), async () => {
    const res = await worker.fetch(post({ code: 'CODE_abc' }), ENV);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Invalid client credentials');
    assert.equal(body.ecode, 'OAUTH_011');
    assert.doesNotMatch(JSON.stringify(body), /client-secret/);
  });
});

test('reports a misconfigured worker instead of calling ClickUp', async () => {
  const res = await worker.fetch(post({ code: 'CODE_abc' }), { ALLOWED_ORIGINS: ORIGIN });
  assert.equal(res.status, 500);
});
