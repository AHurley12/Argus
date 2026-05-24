'use strict';
// netlify/functions/fetch-portwatch.js
// Proxies IMF PortWatch (ArcGIS FeatureServer) to the Argus frontend.
// Handles CORS, month fallback, and field filtering server-side.
//
// Cache architecture:
//   Supabase-backed server cache (6h TTL per period key) eliminates the
//   8-9s ArcGIS cold-fetch on every client request. Cache miss → ArcGIS →
//   write to Supabase → serve. Cache hit → return instantly (~100ms).
//   Graceful stale fallback if ArcGIS fails and unexpired cache exists.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PORTWATCH_URL =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services' +
  '/Daily_Ports_Data/FeatureServer/0/query';

// 80/20 — only high-value fields, no full-row pulls
const OUT_FIELDS = [
  'portid', 'portname', 'country',
  'portcalls',
  'import', 'export',
  'import_container', 'export_container',
  'import_tanker',    'export_tanker',
  'year', 'month', 'date',
].join(',');

const BASE_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
  'Cache-Control': 'public, max-age=600, stale-while-revalidate=120',
};

// 6h TTL — IMF data is daily, ArcGIS is slow (~8-9s cold)
const CACHE_TTL_MS      = 6 * 60 * 60 * 1000;
const STALE_TTL_MS      = 24 * 60 * 60 * 1000;  // serve stale up to 24h on ArcGIS failure
const CACHE_KEY_PREFIX  = 'portwatch_v1_';

function cacheKey(period) {
  return CACHE_KEY_PREFIX + (period || 'unknown');
}

// Build a filtered ArcGIS query URL for a specific year + month
function buildUrl(year, month) {
  const where = `year=${year} AND month=${month}`;
  return (
    PORTWATCH_URL +
    '?where='            + encodeURIComponent(where) +
    '&outFields='        + encodeURIComponent(OUT_FIELDS) +
    '&f=json' +
    '&resultRecordCount=2000'
  );
}

// Fetch with a hard timeout (ArcGIS can be slow)
async function arcgisFetch(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
    const payload = await res.json();
    if (payload.error) throw new Error(`ArcGIS: ${payload.error.message || JSON.stringify(payload.error)}`);
    return Array.isArray(payload.features) ? payload.features : [];
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: BASE_HEADERS, body: '' };
  }

  const supabase = (SUPABASE_URL && SUPABASE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

  const now          = new Date();
  const year         = now.getUTCFullYear();
  const month        = now.getUTCMonth() + 1;
  const currentPeriod = `${year}-${String(month).padStart(2, '0')}`;
  const prevMonth    = month === 1 ? 12 : month - 1;
  const prevYear     = month === 1 ? year - 1 : year;
  const prevPeriod   = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;

  // ── Supabase cache read ────────────────────────────────────────────────────
  // Check current period first, then previous (handles IMF's ~1-month lag).
  let staleRow = null;

  if (supabase) {
    try {
      for (const period of [currentPeriod, prevPeriod]) {
        const { data: row } = await supabase
          .from('argus_cache')
          .select('payload, updated_at')
          .eq('key', cacheKey(period))
          .single();

        if (row && row.payload) {
          const age = Date.now() - new Date(row.updated_at).getTime();
          if (age < CACHE_TTL_MS) {
            // Fresh cache hit — return immediately
            console.log(`[fetch-portwatch] cache hit | period=${period} | age=${Math.round(age/60000)}m`);
            return {
              statusCode: 200,
              headers:    BASE_HEADERS,
              body: JSON.stringify({ ...row.payload, cached: true }),
            };
          }
          // Stale but present — keep as fallback if ArcGIS fails
          if (age < STALE_TTL_MS && !staleRow) staleRow = { row, period };
        }
      }
    } catch (_) { /* cache unavailable — proceed to ArcGIS */ }
  }

  // ── ArcGIS live fetch ──────────────────────────────────────────────────────
  let features = [];
  let period   = '';
  let source   = 'live';

  try {
    // Primary: current month
    features = await arcgisFetch(buildUrl(year, month));
    period   = currentPeriod;

    // Fallback: PortWatch data has ~1-month publication lag
    if (features.length === 0) {
      features = await arcgisFetch(buildUrl(prevYear, prevMonth));
      period   = prevPeriod;
      source   = 'fallback';
      console.log(`[fetch-portwatch] current month empty — fell back to ${period}`);
    }

    console.log(`[fetch-portwatch] live | period=${period} | count=${features.length}`);

    const payload = { features, count: features.length, period, source };

    // ── Supabase cache write ─────────────────────────────────────────────────
    if (supabase && features.length > 0) {
      try {
        await supabase
          .from('argus_cache')
          .upsert(
            { key: cacheKey(period), payload, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          );
        console.log(`[fetch-portwatch] cached to supabase | key=${cacheKey(period)}`);
      } catch (err) {
        console.warn('[fetch-portwatch] cache write failed:', err.message);
      }
    }

    return {
      statusCode: 200,
      headers:    BASE_HEADERS,
      body:       JSON.stringify(payload),
    };

  } catch (err) {
    console.error('[fetch-portwatch] ArcGIS error:', err.message);

    // ── Stale cache fallback ─────────────────────────────────────────────────
    // ArcGIS is down or timed out — serve stale data rather than a 502
    if (staleRow) {
      console.warn(`[fetch-portwatch] serving stale cache | period=${staleRow.period}`);
      return {
        statusCode: 200,
        headers:    BASE_HEADERS,
        body: JSON.stringify({ ...staleRow.row.payload, cached: true, stale: true }),
      };
    }

    return {
      statusCode: 502,
      headers:    BASE_HEADERS,
      body: JSON.stringify({
        error:    err.message,
        features: [],
        count:    0,
        period:   '',
        source:   'error',
      }),
    };
  }
};
