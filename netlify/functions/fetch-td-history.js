// netlify/functions/fetch-td-history.js
// Proxies Yahoo Finance /v8/finance/chart to the Argus frontend.
// No API key required — uses the same public endpoint as fetch-market-data.js.
// Returns { prices: number[], dates: string[] } for the sparkline chart.
//
// Query param: symbol (required) — Yahoo Finance symbol, e.g. "^FTSE", "^N225", "KSA"
// Cache-Control: 10-min CDN cache (chart history doesn't change tick-by-tick)

'use strict';

const YF_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

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

  // Fetch 1Y of daily closes — client slices to 1D/1W/1M/1Y locally from this dataset.
  // Larger upfront fetch eliminates per-timeframe round-trips and keeps request count to 1 per symbol.
  const url = `${YF_CHART}/${encodeURIComponent(symbol)}?range=1y&interval=1d&includeAdjustedClose=false`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'ArgusIntel/1.0', 'Accept': 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`YF HTTP ${res.status}`);

    const data = await res.json();

    if (data.chart && data.chart.error) {
      throw new Error(data.chart.error.description || 'YF chart error');
    }

    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error('YF: no chart result');

    const timestamps = result.timestamp || [];
    const closes     = ((result.indicators.quote || [])[0] || {}).close || [];

    if (!timestamps.length || !closes.length) throw new Error('YF: no price data');

    // Zip timestamps + closes, dropping null entries (market holidays / halts).
    const prices = [];
    const dates  = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null || !isFinite(c)) continue;
      const d  = new Date(timestamps[i] * 1000);
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      prices.push(parseFloat(c.toFixed(4)));
      dates.push(mm + '-' + dd);
    }

    if (!prices.length) throw new Error('YF: all closes null');

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
