// netlify/functions/fetch-yfinance.js
// Real-time market quotes via yahoo-finance2 library (server-side only — no CORS issues).
// Covers: global indexes, commodities, FX, volatility, defense/energy ETFs, shipping proxies.
// Cache: Supabase market_intelligence table, 15-minute TTL.
// Usage: GET /.netlify/functions/fetch-yfinance
//        GET /.netlify/functions/fetch-yfinance?symbols=AAPL,MSFT  (custom/extra symbols)
//        GET /.netlify/functions/fetch-yfinance?group=commodities   (subset)

const yahooFinance = require('yahoo-finance2').default;
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CACHE_TTL_MS  = 15 * 60 * 1000; // 15 minutes
const CACHE_KEY_PFX = 'yfinance_';     // keyed per group in Supabase

// ── Default symbol groups ────────────────────────────────────────────────────
const SYMBOL_GROUPS = {
  indexes: [
    '^GSPC',    // S&P 500
    '^IXIC',    // NASDAQ Composite
    '^DJI',     // Dow Jones Industrial
    '^FTSE',    // FTSE 100
    '^GDAXI',   // DAX
    '^N225',    // Nikkei 225
    '^HSI',     // Hang Seng
    '^FCHI',    // CAC 40
    '^AXJO',    // ASX 200
    '^BSESN',   // BSE Sensex
    '^KS11',    // KOSPI
    '^TWII',    // Taiwan Weighted
    '^VIX',     // CBOE Volatility Index
  ],
  commodities: [
    'GC=F',     // Gold futures
    'SI=F',     // Silver futures
    'PL=F',     // Platinum futures
    'CL=F',     // WTI Crude Oil futures
    'BZ=F',     // Brent Crude futures
    'NG=F',     // Natural Gas futures
    'HG=F',     // Copper futures
    'ZW=F',     // Chicago Wheat futures
    'ZC=F',     // Corn futures
    'ZS=F',     // Soybeans futures
    'LBS=F',    // Lumber futures
    'ALI=F',    // Aluminium futures
  ],
  fx: [
    'DX-Y.NYB', // US Dollar Index
    'EURUSD=X', // EUR/USD
    'GBPUSD=X', // GBP/USD
    'JPY=X',    // USD/JPY
    'CNY=X',    // USD/CNY (offshore CNH proxy)
    'CHFUSD=X', // CHF/USD (safe haven)
    'RUBUSD=X', // RUB/USD (sanctions proxy)
    'TRYUSD=X', // TRY/USD (EM stress)
    'BRLUSD=X', // BRL/USD (EM commodity)
    'CADUSD=X', // CAD/USD (oil currency)
  ],
  geopolitical: [
    'ITA',      // iShares US Aerospace & Defense ETF
    'XAR',      // SPDR S&P Aerospace & Defense ETF
    'CACI',     // CACI International (defense/intelligence)
    'LMT',      // Lockheed Martin
    'RTX',      // Raytheon Technologies
    'XLE',      // Energy Select SPDR ETF
    'UNG',      // United States Natural Gas Fund
    'USO',      // United States Oil Fund
    'GLD',      // SPDR Gold Shares ETF
    'TLT',      // iShares 20+ Year Treasury ETF (risk-off proxy)
    'HYG',      // iShares High Yield Corporate Bond ETF (credit stress)
  ],
  shipping: [
    'ZIM',      // ZIM Integrated Shipping
    'SBLK',     // Star Bulk Carriers (dry bulk — BDI proxy)
    'GOGL',     // Golden Ocean Group
    'STNG',     // Scorpio Tankers
    'INSW',     // International Seaways
    'MATX',     // Matson (transpacific container)
  ],
};

// Flat list of all symbols for the default 'all' group
const ALL_SYMBOLS = Object.values(SYMBOL_GROUPS).reduce(function(acc, arr) {
  arr.forEach(function(s) { if (!acc.includes(s)) acc.push(s); });
  return acc;
}, []);

// Fields to extract from yahoo-finance2 quote response
const QUOTE_FIELDS = [
  'symbol', 'shortName', 'longName', 'quoteType', 'exchange',
  'currency', 'marketState',
  'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent',
  'regularMarketOpen', 'regularMarketDayHigh', 'regularMarketDayLow',
  'regularMarketVolume', 'regularMarketPreviousClose',
  'fiftyTwoWeekHigh', 'fiftyTwoWeekLow',
  'marketCap', 'trailingPE', 'forwardPE',
  'bid', 'ask', 'bidSize', 'askSize',
];

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const params  = event.queryStringParameters || {};
  const group   = (params.group || 'all').toLowerCase();
  const customSymbols = params.symbols
    ? params.symbols.split(',').map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean)
    : [];

  // Determine symbol list
  let symbols;
  if (customSymbols.length) {
    symbols = customSymbols;
  } else if (group === 'all') {
    symbols = ALL_SYMBOLS;
  } else if (SYMBOL_GROUPS[group]) {
    symbols = SYMBOL_GROUPS[group];
  } else {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: 'Unknown group. Valid: ' + Object.keys(SYMBOL_GROUPS).join(', ') + ', all' }),
    };
  }

  const cacheKey = 'yfinance_' + (customSymbols.length ? 'custom_' + symbols.join('_').slice(0, 60) : group);

  try {
    // ── Supabase cache check ─────────────────────────────────────────────────
    if (SUPABASE_URL && SUPABASE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
      const { data: cached } = await supabase
        .from('market_intelligence')
        .select('*')
        .eq('key', cacheKey)
        .single();

      if (cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_TTL_MS) {
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ source: 'cache', data: cached.payload }),
        };
      }
    }

    // ── Fetch via yahoo-finance2 ─────────────────────────────────────────────
    // Suppress validation warnings for unusual tickers (FX, futures)
    const rawQuotes = await yahooFinance.quote(symbols, {}, {
      validateResult: false,
    });

    // Normalize to a clean array regardless of whether input was one symbol or many
    const quotesArr = Array.isArray(rawQuotes) ? rawQuotes : [rawQuotes];

    const quotes = quotesArr
      .filter(function(q) { return q && q.regularMarketPrice != null; })
      .map(function(q) {
        const out = {};
        QUOTE_FIELDS.forEach(function(f) {
          if (q[f] !== undefined && q[f] !== null) out[f] = q[f];
        });
        // Friendly alias fields for frontend convenience
        out.price     = q.regularMarketPrice     ?? null;
        out.change    = q.regularMarketChange     ?? null;
        out.changePct = q.regularMarketChangePercent != null
          ? parseFloat(q.regularMarketChangePercent.toFixed(4))
          : null;
        out.prevClose = q.regularMarketPreviousClose ?? null;
        out.volume    = q.regularMarketVolume        ?? null;
        out.name      = q.shortName || q.longName    || q.symbol;
        return out;
      });

    // Group results back by category for frontend routing
    const grouped = {};
    Object.keys(SYMBOL_GROUPS).forEach(function(grp) {
      const grpSyms = SYMBOL_GROUPS[grp];
      const hits = quotes.filter(function(q) {
        return grpSyms.includes(q.symbol);
      });
      if (hits.length) grouped[grp] = hits;
    });

    const payload = {
      quotes,          // flat array — all successfully fetched quotes
      grouped,         // sorted by category
      requestedCount: symbols.length,
      returnedCount:  quotes.length,
      ts: new Date().toISOString(),
    };

    // ── Write to Supabase cache ──────────────────────────────────────────────
    if (SUPABASE_URL && SUPABASE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
      await supabase.from('market_intelligence').upsert({
        key:        cacheKey,
        payload:    payload,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ source: 'live', data: payload }),
    };

  } catch (err) {
    console.error('fetch-yfinance error:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined }),
    };
  }
};
