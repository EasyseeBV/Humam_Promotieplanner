/*
 * Cloudflare Worker behind the planner page.
 *
 * Visitors do not log in. The worker holds one ClickUp API token (a secret,
 * set once by the workspace owner) and uses it for READ-ONLY access to the
 * allowed list(s). The weekly plan itself never touches ClickUp: it lives in
 * a D1 (SQLite) database bound to this worker.
 *
 * Routes:
 *   GET  /status                      -> { ok, lists, clickup, storage }
 *   GET  /api/v2/list/{id}            -> relayed to ClickUp (allowed lists only)
 *   GET  /api/v2/list/{id}/task?...   -> relayed to ClickUp (allowed lists only)
 *   GET  /plan                        -> { tasks: { taskId: { "YYYY-MM-DD": hours } }, updatedAt }
 *   PUT  /plan/{taskId}  { planning } -> { ok, planning }   (empty planning deletes the row)
 *
 * Environment:
 *   CLICKUP_TOKEN     (secret)  personal API token used for the read-only relay
 *   ALLOWED_LIST_IDS  (var)     comma-separated ClickUp list ids the relay may read
 *   ALLOWED_ORIGINS   (var)     comma-separated page origins allowed to call this worker
 *   DB                (D1)      database with the `plan` table (see schema.sql)
 */

const API_ORIGIN = 'https://api.clickup.com';

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(origin, allowed) {
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function csv(value) {
  return String(value || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

// Personal tokens (pk_...) go as-is, OAuth tokens need "Bearer".
function authValue(token) {
  return /^pk_/i.test(token) ? token : 'Bearer ' + token;
}

// ------------------------------------------------------------------ relay --

// Only these read-only ClickUp calls are allowed, and only for allowed lists.
function relayAllowed(pathname, lists) {
  const p = pathname.replace(/^\/api\/v2/, '');
  const m = /^\/list\/(\d+)(\/task)?$/.exec(p);
  return !!(m && lists.includes(m[1]));
}

async function relay(request, url, cors, env) {
  if (request.method !== 'GET') return json({ err: 'Only GET is relayed' }, 405, cors);
  if (!relayAllowed(url.pathname, csv(env.ALLOWED_LIST_IDS))) return json({ err: 'This ClickUp call is not allowed here' }, 403, cors);
  if (!env.CLICKUP_TOKEN) return json({ err: 'Worker has no CLICKUP_TOKEN configured' }, 503, cors);

  let upstream;
  try {
    upstream = await fetch(API_ORIGIN + url.pathname + url.search, {
      headers: { Authorization: authValue(env.CLICKUP_TOKEN), Accept: 'application/json' },
    });
  } catch {
    return json({ err: 'Could not reach ClickUp' }, 502, cors);
  }
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

// ------------------------------------------------------------------- plan --

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Validate a { "YYYY-MM-DD": hours } object. Returns the cleaned object
// (zero-hour entries dropped) or null when the input is not acceptable.
export function normalizePlanning(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  let n = 0;
  for (const [date, value] of Object.entries(obj)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const h = Number(value);
    if (!Number.isFinite(h) || h < 0 || h > 24) return null;
    if (h > 0) {
      out[date] = Math.round(h * 100) / 100;
      if (++n > 200) return null;
    }
  }
  return out;
}

async function loadPlan(db) {
  const { results } = await db.prepare('SELECT task_id, planning, updated_at FROM plan').all();
  const tasks = {};
  let updatedAt = 0;
  for (const row of results || []) {
    try {
      const planning = normalizePlanning(JSON.parse(row.planning));
      if (planning && Object.keys(planning).length) tasks[row.task_id] = planning;
    } catch { /* skip a corrupt row rather than failing the whole plan */ }
    if (row.updated_at > updatedAt) updatedAt = row.updated_at;
  }
  return { tasks, updatedAt };
}

async function savePlan(db, taskId, planning) {
  if (Object.keys(planning).length === 0) {
    await db.prepare('DELETE FROM plan WHERE task_id = ?1').bind(taskId).run();
    return;
  }
  await db
    .prepare('INSERT INTO plan (task_id, planning, updated_at) VALUES (?1, ?2, ?3) ' +
      'ON CONFLICT(task_id) DO UPDATE SET planning = excluded.planning, updated_at = excluded.updated_at')
    .bind(taskId, JSON.stringify(planning), Date.now())
    .run();
}

async function handlePlan(request, url, cors, env) {
  if (!env.DB) return json({ err: 'Worker has no D1 database bound (DB)' }, 503, cors);
  const m = /^\/plan(?:\/([^/]+))?$/.exec(url.pathname.replace(/\/+$/, ''));
  if (!m) return json({ err: 'Not found' }, 404, cors);
  const taskId = m[1] ? decodeURIComponent(m[1]) : null;

  if (request.method === 'GET' && !taskId) {
    return json(await loadPlan(env.DB), 200, cors);
  }
  if (request.method === 'PUT' && taskId) {
    if (!TASK_ID_RE.test(taskId)) return json({ err: 'Invalid task id' }, 400, cors);
    let body;
    try { body = await request.json(); } catch { return json({ err: 'Body must be JSON' }, 400, cors); }
    const planning = normalizePlanning(body?.planning);
    if (!planning) return json({ err: 'planning must be an object of "YYYY-MM-DD": hours (0-24)' }, 400, cors);
    await savePlan(env.DB, taskId, planning);
    return json({ ok: true, taskId, planning }, 200, cors);
  }
  return json({ err: 'Method not allowed' }, 405, cors);
}

// ------------------------------------------------------------------ entry --

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = csv(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowedOrigins);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
      return json({ err: 'Origin not allowed' }, 403, cors);
    }

    if (path === '/status') {
      return json({
        ok: true,
        lists: csv(env.ALLOWED_LIST_IDS),
        clickup: !!env.CLICKUP_TOKEN,
        storage: !!env.DB,
      }, 200, cors);
    }
    if (path.startsWith('/api/v2/')) return relay(request, url, cors, env);
    if (path === '/plan' || path.startsWith('/plan/')) return handlePlan(request, url, cors, env);
    return json({ err: 'Not found' }, 404, cors);
  },
};
