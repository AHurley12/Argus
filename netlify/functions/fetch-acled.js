// netlify/functions/fetch-acled.js
// ACLED (Armed Conflict Location & Event Data) geopolitical intelligence proxy.
//
// ACLED is sparse geopolitical event intelligence — NOT realtime telemetry.
// Events are historical point-in-time records updated within 24-72h of occurrence.
// This function caches aggressively to minimize API credit consumption.
//
// Caching strategy:
//   - Fresh (< TTL_MS)  → serve immediately, no upstream contact
//   - Stale (< STALE_MS) on upstream error/quota → serve degraded with stale flag
//   - Cross-instance coalescing: if cache written within COALESCE_WINDOW_MS,
//     serve as fresh (another Lambda already fetched)
//   - In-memory coalescing: deduplicates within same warm Lambda instance
//
// ACLED quota errors:
//   - HTTP 429: standard rate limit
//   - HTTP 402: credit exhaustion (Payment Required)
//   Both treated as QUOTA_EXHAUSTED and trigger stale-cache fallback.
//
// Env: ACLED_API_KEY, ACLED_EMAIL, ACLED_BASE_URL, ACLED_POLL_INTERVAL_MS,
//      ENABLE_ACLED, SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const Cache = require('../lib/argus-cache');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ENABLE_ACLED   = (process.env.ENABLE_ACLED || 'true').toLowerCase() !== 'false';
const ACLED_KEY      = process.env.ACLED_API_KEY  || '';
const ACLED_EMAIL    = process.env.ACLED_EMAIL     || '';
const ACLED_BASE_URL = process.env.ACLED_BASE_URL  || 'https://api.acleddata.com/acled/read';

// TTL and stale window — imported from shared constants, overridable via env
const TTL_MS   = parseInt(process.env.ACLED_POLL_INTERVAL_MS || '') || Cache.TTL.ACLED;
const STALE_MS = Cache.STALE.ACLED;

const CACHE_KEY  = 'acled_events_v1';
const MAX_EVENTS = 250;
const HISTORY_DAYS = 90;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function normalizeEvent(raw, index) {
  const lat = parseFloat(raw.latitude);
  const lon = parseFloat(raw.longitude);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const id = raw.event_id_cnty
    || (raw.event_id ? String(raw.event_id) + '_' + (raw.iso || '') : null)
    || ('acled_' + index);

  return {
    id:           id,
    lat:          lat,
    lon:          lon,
    eventType:    raw.event_type      || 'Unknown',
    subEventType: raw.sub_event_type  || null,
    date:         raw.event_date      || null,
    country:      raw.country         || null,
    region:       raw.region          || null,
    actor1:       raw.actor1          || null,
    actor2:       raw.actor2          || null,
    fatalities:   parseInt(raw.fatalities) || 0,
    notes:        (raw.notes || '').slice(0, 150),
    source:       raw.source          || 'ACLED',
  };
}

function getDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── ACLED fetch ───────────────────────────────────────────────────────────────
// Throws with err.status = 429 on rate limit, err.status = 402 on credit exhaustion.
async function fetchAcledData() {
  const since  = getDateNDaysAgo(HISTORY_DAYS);
  const today  = new Date().toISOString().slice(0, 10);

  const params = new URLSearchParams({
    key:                ACLED_KEY,
    email:              ACLED_EMAIL,
    limit:              String(MAX_EVENTS),
    event_date:         since + '|' + today,
    event_date_where:   'BETWEEN',
    fields:             'event_id_cnty,event_date,event_type,sub_event_type,actor1,actor2,country,region,latitude,longitude,fatalities,notes,source',
  });

  const resp = await fetch(ACLED_BASE_URL + '?' + params.toString(), {
    headers: { 'Accept': 'application/json' },
    signal:  AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
  });

  // 429 = rate limit, 402 = credit exhaustion — both are quota errors
  if (resp.status === 429 || resp.status === 402) {
    throw Object.assign(
      new Error('ACLED quota exhausted (HTTP ' + resp.status + ')'),
      { status: resp.status }
    );
  }

  if (!resp.ok) throw new Error('ACLED HTTP ' + resp.status);

  const rawData = await resp.json();
  const rawEvents = rawData && Array.isArray(rawData.data) ? rawData.data : [];
  const events = [];
  const seen   = new Set();

  for (let i = 0; i < rawEvents.length && events.length < MAX_EVENTS; i++) {
    const norm = normalizeEvent(rawEvents[i], i);
    if (!norm) continue;
    if (seen.has(norm.id)) continue;
    seen.add(norm.id);
    events.push(norm);
  }

  return { events, source: 'acled', ts: Date.now(), count: events.length };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (!ENABLE_ACLED) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ events: [], source: 'acled', ts: Date.now(), disabled: true }),
    };
  }

  if (!ACLED_KEY || !ACLED_EMAIL) {
    console.warn('[fetch-acled] ACLED_API_KEY or ACLED_EMAIL not configured');
    return {
      statusCode: 503,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'ACLED credentials not configured', events: [] }),
    };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Cache read ─────────────────────────────────────────────────────────────
  const cached = await Cache.readCache(supabase, CACHE_KEY, TTL_MS, STALE_MS);

  if (cached.isFresh) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // Cross-instance coalescing: another Lambda wrote within COALESCE_WINDOW_MS
  if (cached.wasRecentlyWritten && cached.hasData) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ ...cached.payload, cached: true }),
    };
  }

  // ── Fetch (in-memory coalescing within same Lambda instance) ───────────────
  let payload;
  try {
    payload = await Cache.withCoalescing(CACHE_KEY, fetchAcledData);
  } catch (err) {
    const isQuota = err.status === 429 || err.status === 402;

    if (isQuota) {
      console.error('[QUOTA_EXHAUSTED][fetch-acled] ACLED quota/rate-limit (HTTP ' + err.status + ') —',
        cached.hasData
          ? 'serving stale cache (age=' + Math.round(cached.ageMs / 60000) + 'min)'
          : 'no cache available. Retry in ~24h or check ACLED account credits.');
    } else {
      console.error('[fetch-acled] upstream fetch failed:', err.message);
    }

    // Serve stale cache on quota exhaustion or any upstream failure
    if (cached.isStale && cached.hasData) {
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          ...cached.payload,
          cached:     true,
          degraded:   true,
          staleAgeMs: cached.ageMs,
          error:      isQuota ? 'upstream_quota_exhausted' : 'upstream_error',
        }),
      };
    }

    return {
      statusCode: isQuota ? 429 : 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error:  isQuota
          ? 'ACLED quota exhausted. Data temporarily unavailable; try again in 24h.'
          : 'ACLED upstream unavailable',
        events: [],
      }),
    };
  }

  // ── Cache write ────────────────────────────────────────────────────────────
  await Cache.writeCache(supabase, CACHE_KEY, payload);

  console.log('[fetch-acled] returned', payload.count, 'events (', HISTORY_DAYS, 'day window)');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
    body: JSON.stringify(payload),
  };
};
