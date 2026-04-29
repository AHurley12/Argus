// netlify/functions/fetch-portwatch.js
// Proxies IMF PortWatch (ArcGIS FeatureServer) to the Argus frontend.
// Handles CORS, month fallback, and field filtering server-side.
// No env vars required — ArcGIS endpoint is public.
//
// Polling: frontend calls every 10 minutes.
// Cache-Control: 10-minute CDN cache (data is daily, intra-day calls serve cached copy).

'use strict';

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
  // Daily data — 10-min CDN cache avoids hammering ArcGIS on every poll
  'Cache-Control': 'public, max-age=600, stale-while-revalidate=120',
};

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

  const now   = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  let features = [];
  let period   = '';
  let source   = 'live';

  try {
    // Primary: current month
    features = await arcgisFetch(buildUrl(year, month));
    period   = `${year}-${String(month).padStart(2, '0')}`;

    // Fallback: PortWatch data has a ~1-month publication lag.
    // If current month returns nothing, try previous month automatically.
    if (features.length === 0) {
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear  = month === 1 ? year - 1 : year;
      features = await arcgisFetch(buildUrl(prevYear, prevMonth));
      period   = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
      source   = 'fallback';
      console.log(`[fetch-portwatch] current month empty — fell back to ${period}`);
    }

    console.log(`[fetch-portwatch] ${source} | period=${period} | count=${features.length}`);

    return {
      statusCode: 200,
      headers:    BASE_HEADERS,
      body: JSON.stringify({
        features,
        count:  features.length,
        period,
        source,
      }),
    };

  } catch (err) {
    console.error('[fetch-portwatch] error:', err.message);
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
