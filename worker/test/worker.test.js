// Run with:  node --test   (from the repo root or from worker/)
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { normalizePlanning } from '../worker.js';

const ORIGIN = 'https://easyseebv.github.io';

// Minimal in-memory stand-in for the D1 binding: supports the three statements
// the worker uses.
function fakeD1(rows = []) {
  const table = new Map(rows.map((r) => [r.task_id, { ...r }]));
  return {
    table,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async all() {
          if (/^SELECT/i.test(sql)) return { results: [...table.values()] };
          throw new Error('unexpected all(): ' + sql);
        },
        async run() {
          if (/^DELETE/i.test(sql)) { table.delete(args[0]); return { success: true }; }
          if (/^INSERT/i.test(sql)) { table.set(args[0], { task_id: args[0], planning: args[1], updated_at: args[2] }); return { success: true }; }
          throw new Error('unexpected run(): ' + sql);
        },
      };
      return stmt;
    },
  };
}

function env(overrides = {}) {
  return {
    CLICKUP_TOKEN: 'pk_123_SECRET',
    ALLOWED_LIST_IDS: '901523821635',
    ALLOWED_ORIGINS: 'https://easyseebv.github.io, http://localhost:8765/',
    DB: fakeD1(),
    ...overrides,
  };
}

function req(path, init = {}, origin = ORIGIN) {
  const headers = { Origin: origin, ...(init.headers || {}) };
  return new Request('https://auth.example.workers.dev' + path, { ...init, headers });
}

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}

const j = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

test('normalizePlanning cleans valid input and rejects bad input', () => {
  assert.deepEqual(normalizePlanning({ '2026-09-08': 2.5, '2026-09-09': '1', '2026-09-10': 0 }), { '2026-09-08': 2.5, '2026-09-09': 1 });
  assert.deepEqual(normalizePlanning({}), {});
  assert.equal(normalizePlanning(null), null);
  assert.equal(normalizePlanning([]), null);
  assert.equal(normalizePlanning({ 'not-a-date': 1 }), null);
  assert.equal(normalizePlanning({ '2026-09-08': 25 }), null);
  assert.equal(normalizePlanning({ '2026-09-08': -1 }), null);
  assert.equal(normalizePlanning({ '2026-09-08': 'abc' }), null);
});

test('status and CORS: preflight, allowed origin echoed, foreign origin refused', async () => {
  const pre = await worker.fetch(req('/plan', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PUT' } }), env());
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /PUT/);

  const status = await worker.fetch(req('/status'), env());
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ok: true, lists: ['901523821635'], clickup: true, storage: true });

  const foreign = await worker.fetch(req('/status', {}, 'https://evil.example'), env());
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), ORIGIN); // never echoes the foreign origin

  // Requests without an Origin header (curl, monitoring) are fine for reads.
  const noOrigin = await worker.fetch(new Request('https://x/status'), env());
  assert.equal(noOrigin.status, 200);
});

test('relay: forwards allowed read-only ClickUp calls with the worker token and adds CORS headers', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    return j({ tasks: [{ id: 'a' }], last_page: true });
  }, async () => {
    const res = await worker.fetch(req('/api/v2/list/901523821635/task?page=0&subtasks=true'), env());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.deepEqual(await res.json(), { tasks: [{ id: 'a' }], last_page: true });
  });
  assert.deepEqual(calls, [{ url: 'https://api.clickup.com/api/v2/list/901523821635/task?page=0&subtasks=true', auth: 'pk_123_SECRET' }]);
});

test('relay: everything outside the allowed read-only calls is refused before touching ClickUp', async () => {
  let touched = 0;
  await withFetch(async () => { touched++; return j({}); }, async () => {
    const cases = [
      ['/api/v2/list/999', {}],                                        // other list
      ['/api/v2/list/901523821635/field', {}],                         // not needed, not allowed
      ['/api/v2/task/abc', {}],                                        // single task
      ['/api/v2/team', {}],
      ['/api/v2/list/901523821635/task', { method: 'POST', body: '{}' }],
      ['/api/v2/task/abc', { method: 'DELETE' }],
    ];
    for (const [path, init] of cases) {
      const res = await worker.fetch(req(path, init), env());
      assert.ok(res.status === 403 || res.status === 405, `${init.method || 'GET'} ${path} -> ${res.status}`);
    }
  });
  assert.equal(touched, 0);
});

test('relay: a ClickUp error stays readable (CORS headers added) and a missing token is reported', async () => {
  await withFetch(async () => j({ err: 'Oauth token not found', ECODE: 'OAUTH_019' }, 401), async () => {
    const res = await worker.fetch(req('/api/v2/list/901523821635'), env());
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal((await res.json()).err, 'Oauth token not found');
  });
  const noToken = await worker.fetch(req('/api/v2/list/901523821635'), env({ CLICKUP_TOKEN: '' }));
  assert.equal(noToken.status, 503);
});

test('relay: OAuth-style tokens are sent as Bearer, personal tokens as-is', async () => {
  const auths = [];
  await withFetch(async (url, init) => { auths.push(init.headers.Authorization); return j({}); }, async () => {
    await worker.fetch(req('/api/v2/list/901523821635'), env({ CLICKUP_TOKEN: 'pk_1' }));
    await worker.fetch(req('/api/v2/list/901523821635'), env({ CLICKUP_TOKEN: 'oauthtoken' }));
  });
  assert.deepEqual(auths, ['pk_1', 'Bearer oauthtoken']);
});

test('plan: GET returns all rows as a task map, skipping corrupt rows', async () => {
  const db = fakeD1([
    { task_id: 't1', planning: '{"2026-09-08":2.5}', updated_at: 100 },
    { task_id: 't2', planning: '{"2026-09-09":7}', updated_at: 200 },
    { task_id: 'bad', planning: 'not json', updated_at: 300 },
    { task_id: 'empty', planning: '{}', updated_at: 50 },
  ]);
  const res = await worker.fetch(req('/plan'), env({ DB: db }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tasks: { t1: { '2026-09-08': 2.5 }, t2: { '2026-09-09': 7 } }, updatedAt: 300 });
});

test('plan: PUT upserts, an empty planning deletes, bad input is rejected', async () => {
  const db = fakeD1();
  const e = env({ DB: db });

  const put = await worker.fetch(req('/plan/86cahyqg2', { method: 'PUT', body: JSON.stringify({ planning: { '2026-09-08': 4, '2026-09-09': 0 } }) }), e);
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { ok: true, taskId: '86cahyqg2', planning: { '2026-09-08': 4 } });
  assert.equal(JSON.parse(db.table.get('86cahyqg2').planning)['2026-09-08'], 4);

  const again = await worker.fetch(req('/plan/86cahyqg2', { method: 'PUT', body: JSON.stringify({ planning: { '2026-09-10': 1.25 } }) }), e);
  assert.equal(again.status, 200);
  assert.deepEqual(JSON.parse(db.table.get('86cahyqg2').planning), { '2026-09-10': 1.25 });

  const list = await (await worker.fetch(req('/plan'), e)).json();
  assert.deepEqual(list.tasks, { '86cahyqg2': { '2026-09-10': 1.25 } });

  const del = await worker.fetch(req('/plan/86cahyqg2', { method: 'PUT', body: JSON.stringify({ planning: {} }) }), e);
  assert.equal(del.status, 200);
  assert.equal(db.table.has('86cahyqg2'), false);

  assert.equal((await worker.fetch(req('/plan/86cahyqg2', { method: 'PUT', body: 'nope' }), e)).status, 400);
  assert.equal((await worker.fetch(req('/plan/86cahyqg2', { method: 'PUT', body: JSON.stringify({ planning: { x: 1 } }) }), e)).status, 400);
  assert.equal((await worker.fetch(req('/plan/bad%20id', { method: 'PUT', body: JSON.stringify({ planning: {} }) }), e)).status, 400);
  assert.equal((await worker.fetch(req('/plan/86cahyqg2', { method: 'DELETE' }), e)).status, 405);
  assert.equal((await worker.fetch(req('/plan', { method: 'PUT', body: '{}' }), e)).status, 405);
  assert.equal((await worker.fetch(req('/plan'), env({ DB: undefined }))).status, 503);
});

test('unknown routes are 404', async () => {
  assert.equal((await worker.fetch(req('/nope'), env())).status, 404);
  assert.equal((await worker.fetch(req('/'), env())).status, 404);
});
