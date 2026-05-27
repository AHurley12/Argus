// cloudflare/opensky-proxy.js
// Cloudflare Worker — adsb.fi open data proxy.
//
// Backend: https://opendata.adsb.fi/api (v3, compatible with ADSBexchange v2 format)
// No API key required. Rate limit: 1 req/s.
//
// Browser → this Worker (CORS: *) → opendata.adsb.fi (server-side, no CORS restriction)
//
// Query params accepted: lat, lon, dist (nautical miles, max 250)
// Response: adsb.fi JSON passed through with Access-Control-Allow-Origin: *

const ADSB_BASE = 'https://opendata.adsb.fi/api';

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

  var incoming = new URL(request.url);
  var lat  = incoming.searchParams.get('lat')  || '0';
  var lon  = incoming.searchParams.get('lon')  || '0';
  var dist = incoming.searchParams.get('dist') || '250';

  // Cap dist at 250 NM (adsb.fi hard limit)
  dist = String(Math.min(250, Math.max(1, parseInt(dist) || 250)));

  var target = ADSB_BASE + '/v3/lat/' + lat + '/lon/' + lon + '/dist/' + dist;

  var upstream;
  try {
    upstream = await fetch(target, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ArgusIntel/1.0' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Worker fetch failed: ' + err.message, ac: [] }),
      { status: 502, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) }
    );
  }

  if (!upstream.ok) {
    var errBody = await upstream.text().catch(function() { return ''; });
    return new Response(
      JSON.stringify({ error: 'adsb.fi HTTP ' + upstream.status, detail: errBody.slice(0, 200), ac: [] }),
      { status: upstream.status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) }
    );
  }

  var body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: Object.assign({
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=30',
    }, CORS),
  });
}
