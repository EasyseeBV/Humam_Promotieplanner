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

function post(body, origin = ORIGIN, path = '/') {
  return new Request('https://auth.example.workers.dev' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

// A fake ClickUp: records every call, accepts "Bearer good" (or "plain-only"
// without Bearer) and knows one list.
function fakeClickUp(opts = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    const auth = init?.headers?.Authorization || '';
    calls.push({ url: u, method: init?.method || 'GET', auth, body: init?.body ? JSON.parse(init.body) : null });
    if (u.endsWith('/oauth/token')) return opts.tokenResponse ? opts.tokenResponse() : j({ access_token: 'good' });
    const accepted = auth === 'Bearer good' || auth === 'plain-only';
    if (!accepted) return j({ err: 'Oauth token not found', ECODE: 'OAUTH_019' }, 401);
    if (u.endsWith('/user')) return j({ user: { id: 7, username: 'Humam', email: 'h@x' } });
    if (u.endsWith('/team')) return j({ teams: [{ id: 90151742365, name: 'Easysee' }] });
    if (u.includes('/list/901523821635')) return j({ id: '901523821635', name: 'Promotions' });
    if (u.includes('/list/')) return j({ err: 'Team not authorized', ECODE: 'OAUTH_027' }, 401);
    return j({ err: 'nope' }, 404);
  };
  return { impl, calls };
}

function withFetch(impl, fn) {
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

test('rejects non-POST, foreign origins, bad bodies and unknown routes', async () => {
  const get = await worker.fetch(new Request('https://x/', { headers: { Origin: ORIGIN } }), ENV);
  assert.equal(get.status, 405);

  const foreign = await worker.fetch(post({ code: 'ABCDEF' }, 'https://evil.example'), ENV);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), ORIGIN); // never echoes the foreign origin

  assert.equal((await worker.fetch(post('not json'), ENV)).status, 400);
  assert.equal((await worker.fetch(post({}), ENV)).status, 400);
  assert.equal((await worker.fetch(post({ code: 'a b<script>' }), ENV)).status, 400);
  assert.equal((await worker.fetch(post({ code: 'ABCDEF' }, ORIGIN, '/nope'), ENV)).status, 404);
});

test('exchange: uses the secret, verifies the token and reports scheme, user, teams and list access', async () => {
  const cu = fakeClickUp();
  await withFetch(cu.impl, async () => {
    const res = await worker.fetch(post({ code: 'CODE_abc-1', list_id: '901523821635' }, 'http://localhost:8765'), ENV);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      access_token: 'good',
      ok: true,
      scheme: 'bearer',
      user: { id: 7, username: 'Humam', email: 'h@x' },
      teams: [{ id: '90151742365', name: 'Easysee' }],
      list: { ok: true, id: '901523821635', name: 'Promotions' },
    });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8765');
  });
  const tokenCall = cu.calls.find((c) => c.url.endsWith('/oauth/token'));
  assert.equal(tokenCall.method, 'POST');
  assert.deepEqual(tokenCall.body, { client_id: 'client-id', client_secret: 'client-secret', code: 'CODE_abc-1' });
  // Every ClickUp call after the exchange used the Bearer form.
  assert.ok(cu.calls.filter((c) => !c.url.endsWith('/oauth/token')).every((c) => c.auth === 'Bearer good'));
});

test('exchange: reports missing list access instead of a vague error', async () => {
  const cu = fakeClickUp();
  await withFetch(cu.impl, async () => {
    const res = await worker.fetch(post({ code: 'CODE_abc-1', list_id: '123' }), ENV);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.access_token, 'good');
    assert.deepEqual(body.list, { ok: false, id: '123', status: 401, error: 'Team not authorized' });
  });
});

test('exchange: falls back to the plain header form when Bearer is refused', async () => {
  const cu = fakeClickUp({ tokenResponse: () => j({ access_token: 'plain-only' }) });
  await withFetch(cu.impl, async () => {
    const res = await worker.fetch(post({ code: 'CODE_abc-1' }), ENV);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.scheme, 'plain');
    assert.equal(body.user.username, 'Humam');
  });
});

test('exchange: passes ClickUp OAuth errors through without leaking the secret', async () => {
  const cu = fakeClickUp({ tokenResponse: () => j({ err: 'Code not found', ECODE: 'OAUTH_013' }, 401) });
  await withFetch(cu.impl, async () => {
    const res = await worker.fetch(post({ code: 'CODE_abc' }), ENV);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Code not found');
    assert.equal(body.ecode, 'OAUTH_013');
    assert.doesNotMatch(JSON.stringify(body), /client-secret/);
  });
});

test('exchange: a token ClickUp itself then rejects becomes a clear 502', async () => {
  const cu = fakeClickUp({ tokenResponse: () => j({ access_token: 'broken' }) });
  await withFetch(cu.impl, async () => {
    const res = await worker.fetch(post({ code: 'CODE_abc' }), ENV);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /rejected it: ClickUp rejected the token \(Oauth token not found\)/);
  });
});

test('verify: explains an existing token (valid, and invalid)', async () => {
  const cu = fakeClickUp();
  await withFetch(cu.impl, async () => {
    const good = await worker.fetch(post({ token: 'good', list_id: '901523821635' }, ORIGIN, '/verify'), ENV);
    assert.equal(good.status, 200);
    const gb = await good.json();
    assert.equal(gb.ok, true);
    assert.equal(gb.scheme, 'bearer');
    assert.equal(gb.list.ok, true);

    const bad = await worker.fetch(post({ token: 'garbage-token' }, ORIGIN, '/verify'), ENV);
    assert.equal(bad.status, 200);
    assert.deepEqual(await bad.json(), { ok: false, error: 'ClickUp rejected the token (Oauth token not found)' });

    const malformed = await worker.fetch(post({ token: 'x y' }, ORIGIN, '/verify'), ENV);
    assert.equal(malformed.status, 400);
  });
});

test('reports a misconfigured worker instead of calling ClickUp', async () => {
  const res = await worker.fetch(post({ code: 'CODE_abc' }), { ALLOWED_ORIGINS: ORIGIN });
  assert.equal(res.status, 500);
});
