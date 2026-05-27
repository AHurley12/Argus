// cloudflare/opensky-proxy.js
// Cloudflare Worker — OpenSky Network authenticated proxy.
//
// Problem solved: OpenSky blocks Netlify/AWS IP ranges (server-side proxy dead),
// and browser-direct requests with Authorization headers trigger CORS preflights
// that OpenSky rejects. Cloudflare edge IPs are not blocked by OpenSky.
//
// Flow:
//   Browser → this Worker (CORS: any origin) → OpenSky (Basic Auth, server-side)
//
// Secrets (set via Cloudflare dashboard → Workers → Settings → Variables):
//   OPENSKY_ID     — OpenSky account username (email)
//   OPENSKY_SECRET — OpenSky account password
//
// Deploy: paste this file into the Cloudflare Workers editor, save & deploy.
// Route:  opensky-proxy.<yoursubdomain>.workers.dev   (or custom domain)

const OPENSKY_BASE = 'https://opensky-network.org/api';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Forward query string (lamin/lamax/lomin/lomax bounding box) to OpenSky
    const incoming = new URL(request.url);
    const target   = new URL(OPENSKY_BASE + '/states/all');
    incoming.searchParams.forEach(function(val, key) {
      target.searchParams.set(key, val);
    });

    // Build authenticated request — credentials live in Worker secrets, never in client JS
    const headers = { 'Accept': 'application/json' };
    const user = env.OPENSKY_ID     || '';
    const pass = env.OPENSKY_SECRET || '';
    if (user && pass) {
      headers['Authorization'] = 'Basic ' + btoa(user + ':' + pass);
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), { headers });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Worker fetch failed: ' + err.message, states: null }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    if (upstream.status === 401) {
      return new Response(
        JSON.stringify({ error: 'OpenSky 401 — check OPENSKY_ID / OPENSKY_SECRET secrets', states: null }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    if (upstream.status === 429) {
      return new Response(
        JSON.stringify({ error: 'OpenSky rate limited (429)', states: null }),
        { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: 'OpenSky HTTP ' + upstream.status, states: null }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Stream response body back with CORS headers injected
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  },
};
