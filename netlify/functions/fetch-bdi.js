// netlify/functions/fetch-bdi.js
// Fetches Baltic Dry Index CSV from Stooq, parses last 30 rows.
// No API key required. Server-side fetch bypasses CORS restriction.

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=14400', // 4 hours — BDI is a daily EOD index
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  var source = 'bdi';
  var STOOQ_URL = 'https://stooq.com/q/d/l/?s=bdi&i=d';

  try {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 10000);

    var res = await fetch(STOOQ_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ArgusIntel/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
      },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error('Stooq HTTP ' + res.status);

    var csv = await res.text();
    if (!csv || !csv.trim()) throw new Error('Stooq: empty response');

    // CSV format: Date,Open,High,Low,Close,Volume
    var rows = csv.trim().split('\n').filter(function(r) {
      return r && !r.startsWith('Date') && r.indexOf(',') !== -1;
    });

    if (!rows.length) throw new Error('Stooq: no data rows');

    // Return last 30 rows as [{date, close}]
    var data = rows.slice(-30).map(function(row) {
      var cols  = row.split(',');
      var date  = (cols[0] || '').trim();
      var close = parseFloat(cols[4]);
      return { date: date, close: isNaN(close) ? null : close };
    }).filter(function(r) { return r.date && r.close !== null; });

    if (!data.length) throw new Error('Stooq: no valid rows parsed');

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ data: data, source: source, ts: new Date().toISOString() }),
    };

  } catch (err) {
    console.error('fetch-bdi error:', err.message);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: err.message, source: source }),
    };
  }
};
