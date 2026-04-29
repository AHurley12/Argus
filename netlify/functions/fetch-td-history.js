// netlify/functions/fetch-td-history.js
// Proxies Twelve Data /time_series to the Argus frontend.
// Returns { prices: number[], dates: string[] } normalized for the sparkline chart.
//
// Query param: symbol (required) — TD symbol, e.g. "EWU", "SPY", "BTC/USD"
// Env var:     TD_KEY — Twelve Data API key
// Cache-Control: 10-min CDN cache (chart history doesn't change tick-by-tick)

'use strict';

const TD_BASE = 'https://api.twelvedata.com';

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
  'Cache-Control':                'public, max-age=600, stale-while-revalidate=120',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || '').trim();
  if (!symbol) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'symbol required' }) };
  }

  const apiKey = process.env.TD_KEY;
  if (!apiKey) {
    return { statusCode: 503, headers: HEADERS, body: JSON.stringify({ error: 'TD_KEY not configured' }) };
  }

  const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=30&apikey=${apiKey}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`TD HTTP ${res.status}`);

    const data = await res.json();
    if (!data || data.status === 'error') {
      throw new Error(data && data.message || 'TD error response');
    }

    const values = data.values || [];
    if (!values.length) throw new Error('TD: no values returned');

    // values are newest-first — reverse for chronological order
    const sorted = values.slice().reverse();
    const prices = sorted.map(v => parseFloat(v.close));
    const dates  = sorted.map(v => v.datetime.slice(5)); // "MM-DD" from "YYYY-MM-DD"

    console.log(`[fetch-td-history] ${symbol} — ${prices.length} days`);

    return {
      statusCode: 200,
      headers:    HEADERS,
      body: JSON.stringify({ prices, dates }),
    };

  } catch (err) {
    console.error('[fetch-td-history] error:', err.message);
    return {
      statusCode: 502,
      headers:    HEADERS,
      body: JSON.stringify({ error: err.message, prices: [], dates: [] }),
    };
  }
};
