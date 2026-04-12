// netlify/functions/fetch-gdelt.js
// Fetches GDELT DOC v2 articles for supply chain intelligence signals.
// Cache: Supabase global_events table, 15-minute TTL (GDELT updates every 15 min)

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

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // ── Check Supabase cache ─────────────────────────────────────────────────
    const { data: cached } = await supabase
      .from('global_events')
      .select('*')
      .eq('key', 'gdelt_feed')
      .single();

    if (cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS) {
      return { statusCode: 200, headers, body: JSON.stringify({ source: 'cache', articles: cached.payload }) };
    }

    // ── Fetch from GDELT DOC v2 ──────────────────────────────────────────────
    // Netlify servers have no CORS restriction — direct fetch works
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

    const json     = await res.json();
    const articles = json.articles || [];

    // ── Upsert to Supabase ───────────────────────────────────────────────────
    await supabase.from('global_events').upsert({
      key:        'gdelt_feed',
      payload:    articles,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    return { statusCode: 200, headers, body: JSON.stringify({ source: 'live', articles }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, articles: [] }) };
  }
};
