/*
 * Cloudflare Worker for the planner's "Log in with ClickUp".
 *
 * It exists because two things cannot be done from a public static page:
 *  1. exchanging the OAuth code for a token needs the app's client secret;
 *  2. ClickUp answers 401/403 WITHOUT CORS headers, so the browser cannot read
 *     why a token was rejected. The worker checks the token server-side and
 *     reports the real reason.
 *
 * Routes (all POST, JSON):
 *   /  or /exchange   { code, list_id? }  -> { access_token, scheme, user, teams, list? }
 *   /verify           { token, list_id? } -> { ok, scheme, user, teams, list? } or { ok:false, error }
 *
 * `scheme` says which Authorization header format ClickUp accepted for this
 * token: "bearer" ("Bearer <token>", the documented form) or "plain".
 * `list` reports whether the token can read the given list (workspace access).
 *
 * Environment:
 *   CLICKUP_CLIENT_ID      (var)    public client id of the ClickUp app
 *   CLICKUP_CLIENT_SECRET  (secret) `npx wrangler secret put CLICKUP_CLIENT_SECRET`
 *   ALLOWED_ORIGINS        (var)    comma-separated page origins allowed to call this
 */

const API = 'https://api.clickup.com/api/v2';
const TOKEN_URL = API + '/oauth/token';

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function clickupGet(path, authorization) {
  let res;
  try {
    res = await fetch(API + path, { headers: { Authorization: authorization } });
  } catch {
    return { status: 0, ok: false, data: null, error: 'Could not reach ClickUp' };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, ok: res.ok, data, error: data?.err || data?.error || `HTTP ${res.status}` };
}

// Check a token against ClickUp: which header form works, who it is, which
// workspaces it may see and (optionally) whether it can read one list.
async function verifyToken(token, listId) {
  const attempts = [['bearer', 'Bearer ' + token], ['plain', token]];
  let scheme = null, user = null, lastError = 'unknown error';
  for (const [name, value] of attempts) {
    const r = await clickupGet('/user', value);
    if (r.ok && r.data?.user) { scheme = name; user = r.data.user; break; }
    lastError = r.error;
    if (r.status === 0) break;
  }
  if (!scheme) return { ok: false, error: 'ClickUp rejected the token (' + lastError + ')' };

  const auth = scheme === 'bearer' ? 'Bearer ' + token : token;
  const teamsRes = await clickupGet('/team', auth);
  const teams = (teamsRes.data?.teams || []).map((t) => ({ id: String(t.id), name: t.name }));
  const out = {
    ok: true,
    scheme,
    user: { id: user.id, username: user.username || '', email: user.email || '' },
    teams,
  };
  if (listId) {
    const l = await clickupGet('/list/' + encodeURIComponent(listId), auth);
    out.list = l.ok
      ? { ok: true, id: String(listId), name: l.data?.name || '' }
      : { ok: false, id: String(listId), status: l.status, error: l.error };
  }
  return out;
}

function readListId(body) {
  const v = body?.list_id;
  return typeof v === 'string' && /^\d{1,32}$/.test(v) ? v : null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, cors);
    if (allowed.length && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Body must be JSON' }, 400, cors); }
    const listId = readListId(body);
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    // --- /verify: explain the state of an existing token -------------------
    if (path === '/verify') {
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!/^[A-Za-z0-9_\-.]{4,512}$/.test(token)) return json({ ok: false, error: 'Missing or invalid token' }, 400, cors);
      const v = await verifyToken(token, listId);
      return json(v, 200, cors);
    }

    // --- / or /exchange: code -> token ---------------------------------------
    if (path !== '/' && path !== '/exchange') return json({ error: 'Not found' }, 404, cors);
    if (!env.CLICKUP_CLIENT_ID || !env.CLICKUP_CLIENT_SECRET) {
      return json({ error: 'Worker is missing CLICKUP_CLIENT_ID / CLICKUP_CLIENT_SECRET' }, 500, cors);
    }
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^[A-Za-z0-9_\-.]{4,512}$/.test(code)) return json({ error: 'Missing or invalid code' }, 400, cors);

    let upstream;
    try {
      upstream = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: env.CLICKUP_CLIENT_ID, client_secret: env.CLICKUP_CLIENT_SECRET, code }),
      });
    } catch {
      return json({ error: 'Could not reach ClickUp' }, 502, cors);
    }
    let data = null;
    try { data = await upstream.json(); } catch { data = null; }
    if (!upstream.ok || !data?.access_token) {
      const message = data?.err || data?.error || `ClickUp answered HTTP ${upstream.status}`;
      return json({ error: message, ecode: data?.ECODE }, upstream.ok ? 502 : upstream.status, cors);
    }

    const v = await verifyToken(data.access_token, listId);
    if (!v.ok) return json({ error: 'ClickUp issued a token but then rejected it: ' + v.error }, 502, cors);
    return json({ access_token: data.access_token, ...v }, 200, cors);
  },
};
