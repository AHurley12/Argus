// netlify/functions/fetch-yfinance.js
// Real-time quotes via yahoo-finance2 (server-side only — no CORS issues).
// Default symbols: SPY, QQQ, GLD, ^VIX, ^TNX, ^TYX, USDX, BTC-USD, ETH-USD
// Extra symbols: append via ?symbols=AAPL,TSLA
// Return format: { data: { SYM: { price, change, changePercent, volume, marketCap } }, ts }

const yahooFinance = require('yahoo-finance2').default;

// 'USDX' is a user-friendly alias for the ICE Dollar Index on Yahoo Finance
const ALIAS_TO_TICKER  = { 'USDX': 'DX-Y.NYB' };
const TICKER_TO_ALIAS  = { 'DX-Y.NYB': 'USDX' };

const DEFAULT_SYMBOLS = [
  'SPY',      // S&P 500 ETF
  'QQQ',      // NASDAQ-100 ETF
  'GLD',      // Gold ETF
  '^VIX',     // CBOE Volatility Index
  '^TNX',     // US 10-Year Treasury Yield (× 0.1 = %, but Yahoo gives it as-is in %)
  '^TYX',     // US 30-Year Treasury Yield
  'DX-Y.NYB', // US Dollar Index (returned as USDX)
  'BTC-USD',  // Bitcoin / USD
  'ETH-USD',  // Ethereum / USD
];

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Parse optional extra symbols from query string; resolve any aliases
  const params = event.queryStringParameters || {};
  const extra = params.symbols
    ? params.symbols.split(',').map(function(s) { return (ALIAS_TO_TICKER[s.trim().toUpperCase()] || s.trim().toUpperCase()); }).filter(Boolean)
    : [];

  // Merge defaults + extras, deduplicate
  const seen = {};
  const symbols = DEFAULT_SYMBOLS.concat(extra).filter(function(s) {
    if (seen[s]) return false;
    seen[s] = true;
    return true;
  });

  try {
    // yahoo-finance2 accepts an array → returns an array in the same order
    const rawQuotes = await yahooFinance.quote(symbols, {}, { validateResult: false });
    const quotesArr = Array.isArray(rawQuotes) ? rawQuotes : (rawQuotes ? [rawQuotes] : []);

    const data = {};
    quotesArr.forEach(function(q) {
      if (!q || q.regularMarketPrice == null) return;

      // Use friendly alias as key if one exists (DX-Y.NYB → USDX)
      const key = TICKER_TO_ALIAS[q.symbol] || q.symbol;

      // changePercent: yahoo-finance2 returns e.g. 1.23 meaning 1.23% (not 0.0123)
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
      statusCode: 200,
      headers,
      body: JSON.stringify({ data: data, ts: new Date().toISOString() }),
    };

  } catch (err) {
    console.error('fetch-yfinance error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
