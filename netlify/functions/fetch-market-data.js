// netlify/functions/fetch-market-data.js
// Handles: EIA (Brent, WTI, inventory), FRED (USD index, GEPU, yield curve),
//          Yahoo Finance (global indexes: FTSE, DAX, Nikkei, HSI, VIX — true values)
//          Stooq (BDI + index fallback)
// Cache: Supabase market_intelligence table, 60-minute TTL

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const EIA_KEY       = process.env.EIA_KEY;
const FRED_KEY      = process.env.FRED_KEY;

const CACHE_TTL_MS  = 10 * 60 * 1000; // 10 minutes — macro terminal needs trend, not tick data

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data: cached } = await supabase
      .from('market_intelligence')
      .select('*')
      .eq('key', 'market_snapshot')
      .single();

    if (cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS) {
      return { statusCode: 200, headers, body: JSON.stringify({ source: 'cache', data: cached.payload }) };
    }

    const [eiaResult, fredResult, yahooResult, stooqResult] = await Promise.allSettled([
      fetchEIA(),
      fetchFRED(),
      fetchYahooIndexes(),
      fetchStooq(),
    ]);

    // Yahoo primary, Stooq fills gaps (BDI not on Yahoo)
    const yahooData   = yahooResult.status  === 'fulfilled' ? yahooResult.value  : {};
    const stooqData   = stooqResult.status  === 'fulfilled' ? stooqResult.value  : {};
    const mergedStooq = Object.assign({}, stooqData, yahooData);

    const payload = {
      eia:   eiaResult.status  === 'fulfilled' ? eiaResult.value  : null,
      fred:  fredResult.status === 'fulfilled' ? fredResult.value : null,
      stooq: Object.keys(mergedStooq).length   ? mergedStooq      : null,
      ts:    new Date().toISOString(),
    };

    await supabase.from('market_intelligence').upsert({
      key:        'market_snapshot',
      payload:    payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    return { statusCode: 200, headers, body: JSON.stringify({ source: 'live', data: payload }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Yahoo Finance — true index values, no key, server-side only ──────────────
async function fetchYahooIndexes() {
  const SYMBOLS = {
    '^FTSE':  '^ftse',
    '^GDAXI': '^dax',
    '^N225':  '^n225',
    '^HSI':   '^hsi',
    '^VIX':   '^vix',
  };

  const results = {};
  await Promise.allSettled(
    Object.keys(SYMBOLS).map(async function(ticker) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ArgusIntel/1.0)',
            'Accept': 'application/json',
          }
        });
        if (!res.ok) return;
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        if (!result) return;
        const meta  = result.meta || {};
        const close = meta.regularMarketPrice || meta.previousClose;
        const prev  = meta.chartPreviousClose || meta.previousClose;
        if (!close) return;
        results[SYMBOLS[ticker]] = { close, pct: prev ? ((close - prev) / prev * 100) : 0 };
      } catch(e) {}
    })
  );
  return results;
}

// ── EIA: Brent, WTI, crude inventory ────────────────────────────────────────
async function fetchEIA() {
  const base   = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${EIA_KEY}&frequency=daily&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=1`;
  const invUrl = `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?api_key=${EIA_KEY}&frequency=weekly&data[0]=value&facets[series][]=WCESTUS1&sort[0][column]=period&sort[0][direction]=desc&length=1`;

  const [brentRes, wtiRes, invRes] = await Promise.all([
    fetch(base + '&facets[series][]=RBRTE'),
    fetch(base + '&facets[series][]=RWTC'),
    fetch(invUrl),
  ]);

  function val(json) {
    const row = json?.response?.data?.[0];
    return row ? { value: parseFloat(row.value), period: row.period } : null;
  }

  const [brentJson, wtiJson, invJson] = await Promise.all([brentRes.json(), wtiRes.json(), invRes.json()]);
  const brent = val(brentJson), wti = val(wtiJson), inv = val(invJson);

  return {
    brent:        brent?.value  ?? null,
    brentDate:    brent?.period ?? null,
    wti:          wti?.value    ?? null,
    wtiDate:      wti?.period   ?? null,
    crudeInv:     inv?.value    ?? null,
    crudeInvDate: inv?.period   ?? null,
  };
}

// ── FRED: USD trade index, GEPU, yield curve (10Y-2Y) ───────────────────────
async function fetchFRED() {
  const base = 'https://api.stlouisfed.org/fred/series/observations';

  function url(series) {
    return `${base}?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`;
  }

  function parseVal(json) {
    const v = json?.observations?.[0]?.value;
    return (!v || v === '.') ? null : parseFloat(v);
  }

  const [usdRes, gepuRes, yieldRes] = await Promise.all([
    fetch(url('DTWEXBGS')),
    fetch(url('GEPUCURRENT')),
    fetch(url('T10Y2Y')),
  ]);

  const [usdJson, gepuJson, yieldJson] = await Promise.all([usdRes.json(), gepuRes.json(), yieldRes.json()]);

  return {
    usd:        parseVal(usdJson),
    usdDate:    usdJson?.observations?.[0]?.date  ?? null,
    gepu:       parseVal(gepuJson),
    gepuDate:   gepuJson?.observations?.[0]?.date ?? null,
    yield10y2y: parseVal(yieldJson),
    yieldDate:  yieldJson?.observations?.[0]?.date ?? null,
  };
}

// ── Stooq: BDI + index fallback ──────────────────────────────────────────────
async function fetchStooq() {
  const syms = ['^ftse', '^dax', '^n225', '^hsi', '^vix', 'bdi'].join(',');
  const url  = `https://stooq.com/q/l/?s=${encodeURIComponent(syms)}&f=sd2t2ohlcvn&h&e=csv`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('Stooq HTTP ' + res.status);
  const csv = await res.text();

  const results = {};
  csv.trim().split('\n').forEach(function(row) {
    if (!row || row.startsWith('Symbol')) return;
    const cols  = row.split(',');
    const sym   = (cols[0] || '').trim().toLowerCase();
    const close = parseFloat(cols[5]);
    const open  = parseFloat(cols[3]);
    if (!sym || isNaN(close)) return;
    results[sym] = { close, pct: open ? ((close - open) / open * 100) : 0 };
  });

  return results;
}
