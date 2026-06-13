'use strict';
// netlify/functions/fetch-reliefweb.js
// UN OCHA ReliefWeb active crises proxy with Supabase caching.
//
// ReliefWeb's POST API fails browser CORS preflight — this function proxies server-side.
//
// Caching strategy:
//   Supabase global_events table (key: 'reliefweb_crises', TTL: 1 hour).
//   Falls back to direct ReliefWeb fetch if Supabase env vars are absent.
//
// Response shape:
//   { data: [...], count: N, source: 'reliefweb'|'cache', ts: epoch }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (optional — falls back gracefully)

const RW_URL     = 'https://api.reliefweb.int/v1/disasters?appname=argus-intel';
const TIMEOUT_MS = 10000;
const CACHE_KEY  = 'reliefweb_crises';
const CACHE_TTL  = 60 * 60 * 1000; // 1 hour

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Supabase cache helpers ─────────────────────────────────────────────────────
// Returns null if env vars are absent (graceful degradation in development).
function _makeClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  return createClient(url, key);
}

async function _readCache(sb) {
  if (!sb) return null;
  try {
    const { data } = await sb
      .from('global_events')
      .select('payload, updated_at')
      .eq('key', CACHE_KEY)
      .single();
    if (data && Date.now() - new Date(data.updated_at).getTime() < CACHE_TTL) {
      return data.payload;
    }
  } catch (e) { /* cache miss or table error — fall through */ }
  return null;
}

async function _writeCache(sb, payload) {
  if (!sb) return;
  try {
    await sb.from('global_events').upsert({
      key:        CACHE_KEY,
      payload:    payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (e) { /* non-critical — cache write failure does not fail the response */ }
}

// ── Main handler ───────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const sb = _makeClient();

  // ── Supabase cache check ────────────────────────────────────────────────────
  const cached = await _readCache(sb);
  if (cached) {
    return {
      statusCode: 200,
      headers: Object.assign({}, CORS_HEADERS, {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300',
      }),
      body: JSON.stringify({ data: cached, source: 'cache', ts: Date.now(), count: cached.length }),
    };
  }

  // ── Fetch from ReliefWeb ────────────────────────────────────────────────────
  const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;

  let raw;
  try {
    const resp = await fetch(RW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        filter: { field: 'status', value: 'current' },
        fields: { include: ['name', 'country', 'type', 'date', 'status', 'glide'] },
        limit:  50,
      }),
      signal,
    });

    if (!resp.ok) {
      console.warn('[fetch-reliefweb] HTTP', resp.status);
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ data: [], source: 'reliefweb', ts: Date.now(), count: 0, note: 'upstream HTTP ' + resp.status }),
      };
    }

    raw = await resp.json();
  } catch (err) {
    console.warn('[fetch-reliefweb] fetch error:', err.message);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ data: [], source: 'reliefweb', ts: Date.now(), count: 0, note: err.message }),
    };
  }

  const data = Array.isArray(raw.data) ? raw.data : [];
  console.log('[fetch-reliefweb] fetched', data.length, 'crises from ReliefWeb');

  // ── Write to Supabase cache ─────────────────────────────────────────────────
  await _writeCache(sb, data);

  return {
    statusCode: 200,
    headers: Object.assign({}, CORS_HEADERS, {
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300',
    }),
    body: JSON.stringify({ data, source: 'reliefweb', ts: Date.now(), count: data.length }),
  };
};
