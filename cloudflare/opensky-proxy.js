// cloudflare/opensky-proxy.js
// Cloudflare Worker — adsb.lol supplemental aircraft proxy.
//
// Backend: https://api.adsb.lol/v2 (ADSBexchange v2 format, same source as fetch-traffic)
// No API key required. adsb.lol does not block Cloudflare IP ranges.
//
// Browser → this Worker (CORS: *) → api.adsb.lol (server-side, no CORS restriction)
//
// Query params accepted: lat, lon, dist (nautical miles)
// Response: adsb.lol JSON passed through with Access-Control-Allow-Origin: *

const ADSB_BASE = 'https://api.adsb.lol/v2';

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

  var target = ADSB_BASE + '/lat/' + lat + '/lon/' + lon + '/dist/' + dist;

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
      JSON.stringify({ error: 'adsb.lol HTTP ' + upstream.status, detail: errBody.slice(0, 200), ac: [] }),
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
