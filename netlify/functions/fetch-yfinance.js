const YahooFinance = require('yahoo-finance2').default;
const { createClient } = require('@supabase/supabase-js');

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const TTL_BATCH_MS  = 10 * 60 * 1000;        // 10 min — macro indices, trend not tick
const TTL_SEARCH_MS = 24 * 60 * 60 * 1000;   // 24h  — company profile / cold storage

const ALIAS_TO_TICKER = { 'USDX': 'DX-Y.NYB' };
const TICKER_TO_ALIAS = { 'DX-Y.NYB': 'USDX' };

// We define the bot-proofing here...
const QUOTE_OPTS = { 
  validateResult: false,
  fetchOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }
};

// ... Now the rest of your ALIAS maps and DEFAULT_SYMBOLS can follow ...

const DEFAULT_SYMBOLS = [
  // Big Three indices (pinned ticker tape)
  '^GSPC',    // S&P 500
  '^IXIC',    // NASDAQ Composite
  '^DJI',     // Dow Jones Industrial Average
  // US equities / benchmarks
  'SPY', 'QQQ',
  // Global indexes
  '^FTSE', '^GDAXI', '^N225', '^HSI',
  // Volatility & rates
  '^VIX', '^TNX', '^TYX',
  // Dollar index
  'DX-Y.NYB',
  // FX
  'EURUSD=X', 'GBPUSD=X', 'JPY=X',
  // Commodities
  'GLD', 'SI=F', 'HG=F', 'ZW=F', 'CL=F', 'BZ=F',
  // Crypto
  'BTC-USD', 'ETH-USD',
];


exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const params = event.queryStringParameters || {};

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── Mode: deep-dive quoteSummary ──────────────────────────────────────────
  if (params.search) {
    const raw    = params.search.trim().toUpperCase().replace(/^\$/, '');
    const ticker = ALIAS_TO_TICKER[raw] || raw;
    const cacheKey = 'yf_search_' + ticker;

    // Cold storage — profile data changes at most daily
    try {
      const { data: cached } = await supabase
        .from('market_intelligence')
        .select('*')
        .eq('key', cacheKey)
        .single();
      if (cached && Date.now() - new Date(cached.updated_at).getTime() < TTL_SEARCH_MS) {
        return { statusCode: 200, headers, body: JSON.stringify({ search: cached.payload, ts: cached.updated_at, source: 'cache' }) };
      }
    } catch(_) {}

    try {
      const summary = await yahooFinance.quoteSummary(ticker, {
        modules: ['price', 'summaryDetail', 'assetProfile'],
      }, QUOTE_OPTS);

      const pr = summary.price         || {};
      const sd = summary.summaryDetail || {};
      const ap = summary.assetProfile  || {};

      // yahoo-finance2 v2 returns parsed values directly (no .raw wrapper).
      // regularMarketChangePercent from the price module is a fraction (0.0123 = 1.23%).
      const chgPctRaw = pr.regularMarketChangePercent;
      const chgPct    = chgPctRaw != null
        ? parseFloat((chgPctRaw * 100).toFixed(4))
        : null;

      const result = {
        symbol:        ticker,
        name:          pr.longName || pr.shortName || ticker,
        quoteType:     pr.quoteType   || null,
        currency:      pr.currency    || 'USD',
        // Price & change
        price:         pr.regularMarketPrice            ?? sd.regularMarketPrice ?? null,
        change:        pr.regularMarketChange           ?? sd.regularMarketChange ?? null,
        changePercent: chgPct,
        volume:        pr.regularMarketVolume           ?? sd.regularMarketVolume ?? null,
        // Fundamentals - checking multiple modules for the same data
        trailingPE:    sd.trailingPE  ?? pr.trailingPE ?? null,
        forwardPE:     sd.forwardPE   ?? null,
        marketCap:     pr.marketCap   ?? sd.marketCap  ?? null,
        trailingEps:   null,
        // Performance / moving averages
        fiftyDayAverage:     sd.fiftyDayAverage         ?? pr.fiftyDayAverage    ?? null,
        twoHundredDayAverage: sd.twoHundredDayAverage    ?? pr.twoHundredDayAverage ?? null,
        averageVolume:       sd.averageVolume           ?? pr.averageVolume      ?? null,
        // Company profile
        country:             ap.country                 ?? null,
        industry:            ap.industry                ?? null,
        sector:              ap.sector                  ?? null,
        fullTimeEmployees:   ap.fullTimeEmployees       ?? null,
      };

      const now = new Date().toISOString();
      // Cache profile in Supabase for 24h (cold storage)
      try {
        await supabase.from('market_intelligence').upsert(
          { key: cacheKey, payload: result, updated_at: now },
          { onConflict: 'key' }
        );
      } catch(_) {}

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ search: result, ts: now, source: 'live' }),
      };

    } catch (err) {
      console.error('fetch-yfinance search error:', ticker, err.message);
      // Return 200 with null so the frontend degrades gracefully instead of seeing 500
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ search: null, error: err.message, ts: new Date().toISOString() }),
      };
    }
  }

  // ── Mode: batch quote ─────────────────────────────────────────────────────
  // Check Supabase batch cache first (no extra symbols = default batch only)
  if (!params.symbols) {
    try {
      const { data: cached } = await supabase
        .from('market_intelligence')
        .select('*')
        .eq('key', 'yf_batch')
        .single();
      if (cached && Date.now() - new Date(cached.updated_at).getTime() < TTL_BATCH_MS) {
        return { statusCode: 200, headers, body: JSON.stringify({ data: cached.payload, ts: cached.updated_at, source: 'cache' }) };
      }
    } catch(_) {}
  }

  const extra = params.symbols
    ? params.symbols.split(',')
        .map(function (s) { return ALIAS_TO_TICKER[s.trim().toUpperCase()] || s.trim().toUpperCase(); })
        .filter(Boolean)
    : [];

  const seen = {};
  const symbols = DEFAULT_SYMBOLS.concat(extra).filter(function (s) {
    if (seen[s]) return false;
    seen[s] = true;
    return true;
  });

  try {
    const rawQuotes = await yahooFinance.quote(symbols, {}, QUOTE_OPTS);
    const quotesArr = Array.isArray(rawQuotes) ? rawQuotes : (rawQuotes ? [rawQuotes] : []);

    const data = {};
    quotesArr.forEach(function (q) {
      if (!q || q.regularMarketPrice == null) return;
      const key    = TICKER_TO_ALIAS[q.symbol] || q.symbol;
      const chgPct = q.regularMarketChangePercent != null
        ? parseFloat((q.regularMarketChangePercent * 100).toFixed(4))
        : null;
      data[key] = {
        price:         q.regularMarketPrice,
        change:        q.regularMarketChange    != null ? parseFloat(q.regularMarketChange.toFixed(4))    : null,
        changePercent: chgPct,
        volume:        q.regularMarketVolume    ?? null,
        marketCap:     q.marketCap              ?? null,
      };
    });

    const now = new Date().toISOString();
    // Cache default batch in Supabase for 10 min
    if (!params.symbols) {
      try {
        await supabase.from('market_intelligence').upsert(
          { key: 'yf_batch', payload: data, updated_at: now },
          { onConflict: 'key' }
        );
      } catch(_) {}
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ data: data, ts: now, source: 'live' }),
    };

  } catch (err) {
    console.error('fetch-yfinance batch error:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
