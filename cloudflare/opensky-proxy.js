// cloudflare/opensky-proxy.js
// Cloudflare Worker — OpenSky Network authenticated proxy.
//
// Deploy: paste into Cloudflare Workers editor (Service Worker format), save & deploy.
// Secrets: Workers → Settings → Variables → OPENSKY_ID, OPENSKY_SECRET (both Encrypted)

const OPENSKY_BASE = 'https://opensky-network.org/api';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  // Forward query string (lamin/lamax/lomin/lomax) to OpenSky
  var incoming = new URL(request.url);
  var target   = new URL(OPENSKY_BASE + '/states/all');
  incoming.searchParams.forEach(function(val, key) {
    target.searchParams.set(key, val);
  });

  // Credentials live in Worker environment variables — never in client JS
  var user = typeof OPENSKY_ID     !== 'undefined' ? OPENSKY_ID     : '';
  var pass = typeof OPENSKY_SECRET !== 'undefined' ? OPENSKY_SECRET : '';

  var headers = { 'Accept': 'application/json' };
  if (user && pass) {
    headers['Authorization'] = 'Basic ' + btoa(user + ':' + pass);
  }

  var upstream;
  try {
    upstream = await fetch(target.toString(), { headers: headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Worker fetch failed: ' + err.message, states: null }),
      { status: 502, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) }
    );
  }

  if (upstream.status === 401) {
    return new Response(
      JSON.stringify({ error: 'OpenSky 401 — check OPENSKY_ID / OPENSKY_SECRET secrets', states: null }),
      { status: 502, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) }
    );
  }
  if (upstream.status === 429) {
    return new Response(
      JSON.stringify({ error: 'OpenSky rate limited (429)', states: null }),
      { status: 429, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) }
    );
  }
  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: 'OpenSky HTTP ' + upstream.status, states: null }),
      { status: 502, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) }
    );
  }

  var body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }, CORS),
  });
}
