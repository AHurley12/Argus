// netlify/functions/fetch-acled.js
// ACLED (Armed Conflict Location & Event Data) geopolitical intelligence proxy.
//
// ACLED is sparse geopolitical event intelligence — NOT realtime telemetry.
// Events are historical point-in-time records updated within 24-72h of occurrence.
// This function caches aggressively to minimize API credit consumption.
//
// Cache TTL: 4 hours (configurable via ACLED_POLL_INTERVAL_MS env var).
// Frontend module (modules/argusAcled.js) polls at the same cadence.
//
// Response shape:
//   { events: [...normalizedEvents], source: 'acled', ts: epoch, count: N }
//
// Event schema:
//   { id, lat, lon, eventType, subEventType, date, country, region,
//     actor1, actor2, fatalities, notes, source }
//
// Env: ACLED_API_KEY, ACLED_EMAIL, ACLED_BASE_URL, ACLED_POLL_INTERVAL_MS,
//      ENABLE_ACLED, SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ENABLE_ACLED   = (process.env.ENABLE_ACLED || 'true').toLowerCase() !== 'false';
const ACLED_KEY      = process.env.ACLED_API_KEY  || '';
const ACLED_EMAIL    = process.env.ACLED_EMAIL     || '';
const ACLED_BASE_URL = process.env.ACLED_BASE_URL  || 'https://api.acleddata.com/acled/read';

// Cache TTL: env-driven or 4h default — ACLED is sparse intelligence, not realtime
const POLL_MS      = parseInt(process.env.ACLED_POLL_INTERVAL_MS || String(4 * 60 * 60 * 1000));
const CACHE_KEY    = 'acled_events_v1';
const CACHE_TTL_MS = POLL_MS;

// Max events per cycle — prevents oversized payloads
const MAX_EVENTS = 500;

// Lookback window in days
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

  // Stable ID: prefer composite key, fall back to index
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
    notes:        (raw.notes || '').slice(0, 300),
    source:       raw.source          || 'ACLED',
  };
}

function getDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Feature gate — return empty payload if disabled
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

  // ── Supabase cache read ────────────────────────────────────────────────────
  try {
    const { data: row } = await supabase
      .from('argus_cache')
      .select('payload, updated_at')
      .eq('key', CACHE_KEY)
      .single();

    if (row && row.payload) {
      const age = Date.now() - new Date(row.updated_at).getTime();
      if (age < CACHE_TTL_MS) {
        return {
          statusCode: 200,
          headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
          body: JSON.stringify({ ...row.payload, cached: true }),
        };
      }
    }
  } catch (_) { /* cache miss — proceed to fetch */ }

  // ── ACLED API fetch ────────────────────────────────────────────────────────
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

  let rawData;
  try {
    const url    = ACLED_BASE_URL + '?' + params.toString();
    const resp   = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    });
    if (!resp.ok) throw new Error('ACLED HTTP ' + resp.status);
    rawData = await resp.json();
  } catch (err) {
    console.error('[fetch-acled] upstream fetch failed:', err.message);
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'ACLED upstream unavailable', events: [] }),
    };
  }

  const rawEvents = rawData && Array.isArray(rawData.data) ? rawData.data : [];
  const events    = [];
  const seen      = new Set();

  for (let i = 0; i < rawEvents.length && events.length < MAX_EVENTS; i++) {
    const norm = normalizeEvent(rawEvents[i], i);
    if (!norm) continue;
    if (seen.has(norm.id)) continue;
    seen.add(norm.id);
    events.push(norm);
  }

  const payload = { events, source: 'acled', ts: Date.now(), count: events.length };

  // ── Supabase cache write ───────────────────────────────────────────────────
  try {
    await supabase
      .from('argus_cache')
      .upsert(
        { key: CACHE_KEY, payload, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
  } catch (err) {
    console.warn('[fetch-acled] cache write failed:', err.message);
  }

  console.log('[fetch-acled] returned', events.length, 'events (', HISTORY_DAYS, 'day window)');

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' },
    body: JSON.stringify(payload),
  };
};
