// netlify/functions/fetch-yfinance.js
// Two modes:
//   GET /?symbols=SPY,AAPL   — batch real-time quotes (default symbol set + extras)
//   GET /?search=AAPL        — deep-dive quoteSummary with fundamentals + profile

// 1. You import the "Blueprint" (the Class)
const yahooFinance = require('yahoo-finance2').default;


// The '.default' at the end of the require handles the "constructor" 
// logic automatically in the background.

const ALIAS_TO_TICKER = { 'USDX': 'DX-Y.NYB' };
const TICKER_TO_ALIAS = { 'DX-Y.NYB': 'USDX' };

// Default batch — always fetched for the market panel ticker tape + existing DOM
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

const QUOTE_OPTS = { validateResult: false };

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const params = event.queryStringParameters || {};

  // ── Mode: deep-dive quoteSummary ──────────────────────────────────────────
  if (params.search) {
    const raw    = params.search.trim().toUpperCase().replace(/^\$/, '');
    const ticker = ALIAS_TO_TICKER[raw] || raw;

    try {
      const summary = await yahooFinance.quoteSummary(ticker, {
        modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'assetProfile'],
      }, QUOTE_OPTS);

      const pr = summary.price            || {};
      const sd = summary.summaryDetail    || {};
      const ks = summary.defaultKeyStatistics || {};
      const ap = summary.assetProfile     || {};

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
        trailingPE:    sd.trailingPE  ?? ks.trailingPE  ?? pr.trailingPE ?? null,
        forwardPE:     sd.forwardPE   ?? ks.forwardPE   ?? null,
        marketCap:     pr.marketCap   ?? sd.marketCap   ?? null,
        trailingEps:   ks.trailingEps                   ?? null,
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

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ search: result, ts: new Date().toISOString() }),
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
        ? parseFloat(q.regularMarketChangePercent.toFixed(4))
        : null;
      data[key] = {
        price:         q.regularMarketPrice,
        change:        q.regularMarketChange    != null ? parseFloat(q.regularMarketChange.toFixed(4))    : null,
        changePercent: chgPct,
        volume:        q.regularMarketVolume    ?? null,
        marketCap:     q.marketCap              ?? null,
      };
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ data: data, ts: new Date().toISOString() }),
    };

  } catch (err) {
    console.error('fetch-yfinance batch error:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
