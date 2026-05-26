// netlify/functions/fetch-gdelt.js
// Fetches GDELT DOC v2 articles for supply chain intelligence signals.
// Cache: Supabase global_events table, 25-minute TTL (GDELT updates every 15 min)
//
// Resilience: GDELT is a free public API with no SLA.
// On fetch failure or non-JSON response, serve stale cache rather than 500.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CACHE_TTL_MS = 25 * 60 * 1000; // 25 minutes — GDELT propagates ~5-10 min after update

const GDELT_QUERY = '(supply chain OR shipping OR sanctions OR conflict OR war OR Houthi OR Suez OR Hormuz OR Russia OR China OR Iran OR semiconductor OR tariff OR embargo OR famine OR coup OR pipeline)';

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Supabase not configured', articles: [] }) };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // ── Check Supabase cache ─────────────────────────────────────────────────
    const { data: cached } = await supabase
      .from('global_events')
      .select('payload,updated_at')
      .eq('key', 'gdelt_feed')
      .single();

    const cacheAge = cached ? Date.now() - new Date(cached.updated_at).getTime() : Infinity;

    if (cached && cacheAge < CACHE_TTL_MS) {
      return { statusCode: 200, headers, body: JSON.stringify({ source: 'cache', articles: cached.payload || [] }) };
    }

    // ── Fetch from GDELT DOC v2 ──────────────────────────────────────────────
    let articles = null;
    let gdeltError = null;

    try {
      const gdeltUrl = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      gdeltUrl.searchParams.set('query',      GDELT_QUERY);
      gdeltUrl.searchParams.set('mode',       'ArtList');
      gdeltUrl.searchParams.set('maxrecords', '15');
      gdeltUrl.searchParams.set('format',     'json');
      gdeltUrl.searchParams.set('timespan',   '48h');
      gdeltUrl.searchParams.set('sort',       'DateDesc');

      const res = await fetch(gdeltUrl.toString(), {
        headers: { 'User-Agent': 'ArgusIntel/1.0' },
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) throw new Error('GDELT HTTP ' + res.status);

      // GDELT occasionally returns HTML error pages with a 200 status.
      // Guard against non-JSON bodies before calling .json().
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch(parseErr) {
        throw new Error('GDELT non-JSON response: ' + text.slice(0, 120));
      }

      articles = Array.isArray(json.articles) ? json.articles : [];

    } catch(fetchErr) {
      gdeltError = fetchErr.message;
      console.warn('[fetch-gdelt] GDELT fetch failed:', fetchErr.message);
    }

    // ── Stale-cache fallback ─────────────────────────────────────────────────
    // If GDELT failed but we have any cached data (even expired), serve it.
    if (articles === null) {
      if (cached && Array.isArray(cached.payload) && cached.payload.length) {
        console.log('[fetch-gdelt] serving stale cache (age=' + Math.round(cacheAge / 60000) + 'min) after GDELT error');
        return { statusCode: 200, headers, body: JSON.stringify({ source: 'stale_cache', articles: cached.payload, error: gdeltError }) };
      }
      // No cache at all — return empty rather than 500
      return { statusCode: 200, headers, body: JSON.stringify({ source: 'empty', articles: [], error: gdeltError }) };
    }

    // ── Upsert fresh data to Supabase ────────────────────────────────────────
    await supabase.from('global_events').upsert({
      key:        'gdelt_feed',
      payload:    articles,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    return { statusCode: 200, headers, body: JSON.stringify({ source: 'live', articles }) };

  } catch (err) {
    console.error('[fetch-gdelt] unexpected error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, articles: [] }) };
  }
};
