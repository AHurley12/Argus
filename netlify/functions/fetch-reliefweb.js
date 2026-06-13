'use strict';
// netlify/functions/fetch-reliefweb.js
// UN OCHA ReliefWeb active crises proxy with Supabase caching.
//
// ReliefWeb's POST API fails browser CORS preflight — this function proxies server-side.
//
// Filter strategy:
//   Primary:  POST with filter { field: 'status', value: 'current' }
//   Fallback: POST without filter (returns all, sorted by date desc, limit 50)
//             Used when primary returns 0 — distinguishes API filter errors from true empty.
//
// Caching strategy:
//   Supabase global_events table (key: 'reliefweb_crises', TTL: 1 hour).
//   Falls back to direct ReliefWeb fetch if Supabase env vars are absent.
//   Empty results are NOT cached (avoids poisoning cache on transient errors).
//
// Response shape:
//   { data: [...], count: N, source: 'reliefweb'|'cache', ts: epoch, rawTotal: N }
//   On error: { data: [], count: 0, note: 'reason', ... }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (optional — falls back gracefully)

const RW_URL     = 'https://api.reliefweb.int/v1/disasters?appname=argus-intel';
const TIMEOUT_MS = 12000;
const CACHE_KEY  = 'reliefweb_crises';
const CACHE_TTL  = 60 * 60 * 1000; // 1 hour

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

const FIELDS = ['name', 'country', 'type', 'date', 'status', 'glide'];

// ── Supabase cache helpers ─────────────────────────────────────────────────────
// Returns null if env vars are absent (graceful degradation in development).
function _makeClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key);
  } catch (e) {
    console.warn('[fetch-reliefweb] @supabase/supabase-js not available:', e.message);
    return null;
  }
}

async function _readCache(sb) {
  if (!sb) return null;
  try {
    const { data } = await sb
      .from('global_events')
      .select('payload, updated_at')
      .eq('key', CACHE_KEY)
      .single();
    if (data && data.payload && data.payload.length > 0 &&
        Date.now() - new Date(data.updated_at).getTime() < CACHE_TTL) {
      return data.payload;
    }
  } catch (e) { /* cache miss or table error — fall through */ }
  return null;
}

async function _writeCache(sb, payload) {
  if (!sb || !payload || !payload.length) return; // never cache empty results
  try {
    await sb.from('global_events').upsert({
      key:        CACHE_KEY,
      payload:    payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (e) { /* non-critical — cache write failure does not fail the response */ }
}

// ── Single ReliefWeb POST ──────────────────────────────────────────────────────
async function _rwFetch(body, signal) {
  const resp = await fetch(RW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw new Error('upstream HTTP ' + resp.status);
  return resp.json();
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

  let raw, data;
  try {
    // Primary: filter to status=current
    raw = await _rwFetch({
      filter: { field: 'status', value: 'current' },
      fields: { include: FIELDS },
      limit:  50,
    }, signal);

    data = Array.isArray(raw.data) ? raw.data : [];
    console.log('[fetch-reliefweb] primary: data.length=' + data.length +
      ' raw.count=' + raw.count + ' raw.totalCount=' + raw.totalCount +
      ' raw.keys=' + Object.keys(raw).join(','));

    // Fallback: if primary returns 0, try without filter to detect API shape issues
    if (data.length === 0) {
      console.warn('[fetch-reliefweb] primary returned 0 — trying fallback (no filter)');
      const fallbackRaw = await _rwFetch({
        fields: { include: FIELDS },
        limit:  10,
      }, signal);
      const fallbackData = Array.isArray(fallbackRaw.data) ? fallbackRaw.data : [];
      console.log('[fetch-reliefweb] fallback: data.length=' + fallbackData.length +
        ' raw.count=' + fallbackRaw.count + ' raw.keys=' + Object.keys(fallbackRaw).join(','));

      // If fallback returned results, the filter is broken — use all results filtered client-side
      if (fallbackData.length > 0) {
        console.warn('[fetch-reliefweb] filter broken — using fallback data, filter client-side');
        // Re-fetch with higher limit and no filter
        const fullRaw = await _rwFetch({
          fields: { include: FIELDS },
          limit:  50,
        }, signal);
        data = Array.isArray(fullRaw.data) ? fullRaw.data : [];
        // Filter client-side: keep only current disasters
        data = data.filter(function(item) {
          var s = item.fields && item.fields.status;
          return !s || s === 'current' || (Array.isArray(s) && s.some(function(v) {
            return v === 'current' || (v && v.name === 'current');
          }));
        });
        console.log('[fetch-reliefweb] after client-side filter: ' + data.length + ' current disasters');
      } else {
        console.warn('[fetch-reliefweb] both primary and fallback returned 0 — API may be down');
      }
    }

  } catch (err) {
    console.warn('[fetch-reliefweb] fetch error:', err.message);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ data: [], source: 'reliefweb', ts: Date.now(), count: 0, note: err.message }),
    };
  }

  // Only write to Supabase cache if we got real data
  if (data.length > 0) await _writeCache(sb, data);

  return {
    statusCode: 200,
    headers: Object.assign({}, CORS_HEADERS, {
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300',
    }),
    body: JSON.stringify({ data, source: 'reliefweb', ts: Date.now(), count: data.length }),
  };
};
