/*
 * Cloudflare Worker: exchanges a ClickUp OAuth authorization code for an
 * access token. It exists only because that exchange needs the app's client
 * secret, which must never ship inside the public GitHub Pages site.
 *
 * Request:  POST { "code": "<code from ClickUp redirect>" }
 * Response: 200 { "access_token": "..." }  or  { "error": "..." } with 4xx/5xx
 *
 * Environment:
 *   CLICKUP_CLIENT_ID      (var)    public client id of the ClickUp app
 *   CLICKUP_CLIENT_SECRET  (secret) `npx wrangler secret put CLICKUP_CLIENT_SECRET`
 *   ALLOWED_ORIGINS        (var)    comma-separated page origins allowed to call this
 */

const TOKEN_URL = 'https://api.clickup.com/api/v2/oauth/token';

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
    if (!env.CLICKUP_CLIENT_ID || !env.CLICKUP_CLIENT_SECRET) {
      return json({ error: 'Worker is missing CLICKUP_CLIENT_ID / CLICKUP_CLIENT_SECRET' }, 500, cors);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Body must be JSON' }, 400, cors); }
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^[A-Za-z0-9_\-.]{4,512}$/.test(code)) return json({ error: 'Missing or invalid code' }, 400, cors);

    let upstream;
    try {
      upstream = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: env.CLICKUP_CLIENT_ID,
          client_secret: env.CLICKUP_CLIENT_SECRET,
          code,
        }),
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
    return json({ access_token: data.access_token }, 200, cors);
  },
};
